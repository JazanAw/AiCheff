import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import {
  isNameQualityFragment,
  isNameQualityNormalized,
  repairNonFragmentNameQuality,
  NAME_QUALITY_TAG,
  NAME_QUALITY_REVIEW_REASON,
} from './nameQualityQuarantine';
import { classifyFoodDecision, isFragmentOrSectionHeader } from './foodDecision';
import { classifyReviewQueueClass } from './reviewReductionClasses';
import { applyFragmentQuarantineGate } from './offersScanV2';

// Task — Name-Quality darf nur Namensfragmente/Schrottnamen erfassen, nicht echte
// Ein-Wort-PRODUKTE. Die Fixtures sind die EXAKTEN Snapshot-Shapes aus dem
// aktuellen Full-Scan (backend/data/offers.json). KEINE Produkt-/Marken-Allowlist,
// keine KW-Logik — die Unterscheidung ist strukturell: konnte der Categorizer den
// Ein-Wort-Namen POSITIV identifizieren (hohe Confidence + konkrete Sub-Kategorie)?
// Dann ist es ein echtes Produkt, kein Namensmüll.

function offer(name: string, extra: Partial<Offer> & Record<string, unknown> = {}): Offer {
  return {
    id: name,
    name,
    normalizedName: name.toLowerCase(),
    storeChain: 'ALDI NORD',
    category: 'Sonstiges',
    price: 1.11,
    currency: 'EUR',
    unit: 'stück',
    sourceUrl: 'https://example.com',
    tags: [],
    createdAt: '2026-06-14T00:00:00.000Z',
    ...extra,
  } as Offer;
}

/** Persisted neutralisierte Shape (Tag gesetzt, canonicalCategory.isNonFood=false,
 *  reasons enthält quarantine:name_quality) — wie nach markNameQualityFragment. */
function persistedNameQuality(
  name: string,
  canonical: Record<string, unknown>,
  reviewReason = 'name_quality_fragment',
): Offer {
  return offer(name, {
    foodFlag: 'unsure',
    reviewNeeded: true,
    reviewReason,
    tags: ['filiale', 'name_quality', 'reviewNeeded'],
    canonicalCategory: {
      sub: 'unknown',
      isNonFood: false,
      confidence: 0.3,
      ...canonical,
      reasons: [...((canonical.reasons as string[]) ?? []), 'quarantine:name_quality'],
    },
  });
}

// ── Echte Ein-Wort-PRODUKTE: confident Non-Food-Klassifikation (conf≥0.6 + Sub) ──

const realProducts: ReadonlyArray<[string, string, number]> = [
  ['Fitnessbänder', 'Küche & Geräte', 0.8],
  ['Gewichte', 'Küche & Geräte', 0.8],
  ['Pfannen', 'Küche & Geräte', 0.9],
  ['Küchenhelfer', 'Küche & Geräte', 0.9],
  ['Trinkflasche', 'Küche & Geräte', 0.8],
  ['Kopierpapier', 'Papier', 0.9],
  ['Wäscheklammern', 'Haushalt', 0.9],
  ['Bartnelke', 'Garten', 0.8],
  ['Gartenspritze', 'Garten', 0.9],
];

describe('Name-Quality — echte Ein-Wort-Produkte sind KEINE Namensfragmente', () => {
  for (const [name, sub, confidence] of realProducts) {
    it(`„${name}" (confident ${sub}) ist kein name_quality-Fragment`, () => {
      const persisted = persistedNameQuality(name, { sub, confidence });
      expect(isNameQualityFragment(persisted)).toBe(false);
      expect(isFragmentOrSectionHeader(persisted)).toBe(false);
      expect(classifyReviewQueueClass(persisted)).not.toBe('name_quality');
    });

    it(`frisches „${name}" (isNonFood=true, ohne Tag) wird nicht neu quarantänisiert`, () => {
      const fresh = offer(name, {
        foodFlag: 'unsure',
        canonicalCategory: { sub, isNonFood: true, confidence, reasons: ['cache:hit'] },
      });
      expect(isNameQualityFragment(fresh)).toBe(false);
    });
  }
});

// ── Echte Fragmente: schwache/keine Identifikation (conf 0.3, sub unknown) ──

describe('Name-Quality — schwach identifizierte Ein-Wort-Namen bleiben Fragmente', () => {
  it('„kernarm" (conf 0.3, unknown) bleibt name_quality — fresh UND persisted', () => {
    const fresh = offer('kernarm', {
      foodFlag: 'unsure',
      unit: '1-kg',
      category: 'Getränke Alkoholfrei',
      sourceCategoryRaw: 'Angebote im Markt',
      canonicalCategory: {
        sub: 'unknown',
        isNonFood: true,
        confidence: 0.3,
        reasons: ["Product name 'kernarm' does not indicate a food item.", 'cache:hit'],
      },
    });
    expect(isNameQualityFragment(fresh)).toBe(true);

    const persisted = persistedNameQuality(
      'kernarm',
      { sub: 'unknown', confidence: 0.3, reasons: ["does not indicate a food item", 'cache:hit'] },
      'unknown_sub,low_confidence,name_quality_fragment',
    );
    expect(isNameQualityFragment(persisted)).toBe(true);
    expect(isFragmentOrSectionHeader(persisted)).toBe(true);
    expect(classifyReviewQueueClass(persisted)).toBe('name_quality');
  });

  for (const name of ['Buch', 'Kiezmische']) {
    it(`„${name}" (conf 0.3, unknown) bleibt name_quality`, () => {
      const persisted = persistedNameQuality(
        name,
        { sub: 'unknown', confidence: 0.3 },
        'unknown_sub,low_confidence,name_quality_fragment',
      );
      expect(isNameQualityFragment(persisted)).toBe(true);
      expect(classifyReviewQueueClass(persisted)).toBe('name_quality');
    });
  }

  it('harte Descriptor-Fragmente „extra"/„Original" bleiben name_quality trotz hoher Confidence', () => {
    const extra = persistedNameQuality('extra', { sub: 'Käse', confidence: 0.9 });
    const original = persistedNameQuality('Original', { sub: 'Sekt', confidence: 0.9 });
    expect(isNameQualityFragment(extra)).toBe(true);
    expect(isNameQualityFragment(original)).toBe(true);
  });
});

// ── Spritzring: aktueller Full-Scan hat zusätzliche Belege (kein Food-Votum mehr) ──

describe('Name-Quality — Spritzring', () => {
  it('aktuelle Snapshot-Shape (foodFlag=unsure, confident Küche & Geräte) ist nonfood_like, nicht name_quality', () => {
    const spritzring = offer('Spritzring', {
      foodFlag: 'unsure',
      category: 'Getränke Alkoholfrei',
      sourceCategoryRaw: 'Filialangebote',
      storeChain: 'Netto',
      tags: ['filiale', 'reduziert', 'name_quality', 'reviewNeeded'],
      reviewNeeded: true,
      reviewReason: 'name_quality_fragment',
      canonicalCategory: {
        sub: 'Küche & Geräte',
        isNonFood: false,
        confidence: 0.8,
        reasons: ['Spritzring ist ein Küchenutensil', 'cache:hit', 'quarantine:name_quality'],
      },
    });
    expect(isNameQualityFragment(spritzring)).toBe(false);
    expect(classifyReviewQueueClass(spritzring)).toBe('nonfood_like');
  });

  it('alte Cache-Konflikt-Shape (foodFlag=food) bleibt cache_conflict, nicht name_quality', () => {
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
    expect(classifyReviewQueueClass(spritzring)).toBe('cache_conflict');
  });
});

// ── Idempotente Reparatur falsch persistierter name_quality-Tags ──

describe('repairNonFragmentNameQuality — denormalisiert nur echte Produkte', () => {
  it('entfernt name_quality von einem echten Produkt (Gewichte) und stellt Non-Food wieder her', () => {
    const persisted = persistedNameQuality('Gewichte', { sub: 'Küche & Geräte', confidence: 0.8 });
    const repaired = repairNonFragmentNameQuality(persisted);
    expect((repaired.tags ?? [])).not.toContain(NAME_QUALITY_TAG);
    const reviewReason = String((repaired as Offer & { reviewReason?: unknown }).reviewReason ?? '');
    expect(reviewReason.split(',').map((p) => p.trim())).not.toContain(NAME_QUALITY_REVIEW_REASON);
    const cc = (repaired as Offer & { canonicalCategory?: { isNonFood?: unknown; reasons?: unknown } })
      .canonicalCategory;
    expect(cc?.isNonFood).toBe(true);
    expect((cc?.reasons as string[]) ?? []).not.toContain('quarantine:name_quality');
    expect(isNameQualityFragment(repaired)).toBe(false);
    // idempotent: ein zweiter Lauf ändert nichts mehr.
    expect(repairNonFragmentNameQuality(repaired)).toBe(repaired);
  });

  it('lässt ein echtes Fragment (kernarm) unverändert tagged', () => {
    const persisted = persistedNameQuality(
      'kernarm',
      { sub: 'unknown', confidence: 0.3 },
      'unknown_sub,name_quality_fragment',
    );
    const repaired = repairNonFragmentNameQuality(persisted);
    expect(repaired).toBe(persisted);
    expect((repaired.tags ?? [])).toContain(NAME_QUALITY_TAG);
  });
});

// ── Gate-/Report-Integration über die echten Buckets ──

describe('applyFragmentQuarantineGate — repariert falsche Tags und behält Fragmente', () => {
  it('denormalisiert echte Produkte im Filter, hält kernarm als name_quality', () => {
    const result = applyFragmentQuarantineGate({
      offers: [],
      nextWeekOffers: [],
      filteredOffers: [
        persistedNameQuality('Gewichte', { sub: 'Küche & Geräte', confidence: 0.8 }),
        persistedNameQuality('Pfannen', { sub: 'Küche & Geräte', confidence: 0.9 }),
        persistedNameQuality(
          'kernarm',
          { sub: 'unknown', confidence: 0.3 },
          'unknown_sub,name_quality_fragment',
        ),
      ],
    });
    expect(result.repairedCount).toBe(2);
    const byName = new Map(result.filteredOffers.map((o) => [o.name, o]));
    expect((byName.get('Gewichte')?.tags ?? [])).not.toContain(NAME_QUALITY_TAG);
    expect((byName.get('Pfannen')?.tags ?? [])).not.toContain(NAME_QUALITY_TAG);
    expect((byName.get('kernarm')?.tags ?? [])).toContain(NAME_QUALITY_TAG);
    // repariertes Produkt ist als normalisiert kein Fragment mehr.
    expect(isNameQualityNormalized(byName.get('Gewichte') as Offer)).toBe(false);
    expect(classifyFoodDecision(byName.get('Gewichte') as Offer)).toBe('uncertain');
  });
});
