import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import {
  isNameQualityFragment,
  NAME_QUALITY_TAG,
} from './nameQualityQuarantine';
import { classifyFoodDecision, isFragmentOrSectionHeader } from './foodDecision';
import {
  applyFragmentQuarantineGate,
  quarantineFragmentOffers,
} from './offersScanV2';
import { classifyFilteredOfferForRescue } from './snapshotFoodRescue';

// Task P2 — generische Fragment-/Namensqualitätsregel. „kernarm" ist ein REWE-
// Eigenschaftswort-Fragment, kein echtes Angebot. Produktnamen sind reine
// Reproduktions-Fixtures; KEINE Fragment-Allow-/Blocklist im Produktivcode.

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

/** Die exakte REWE-„kernarm"-Shape: ein isoliertes Eigenschaftswort mit einem
 *  cache-getriebenen Non-Food-Verdikt und foodFlag=unsure. */
function kernarm(): Offer {
  return offer('kernarm', {
    foodFlag: 'unsure',
    sourceCategoryRaw: 'Angebote im Markt',
    canonicalCategory: {
      main: 'Non-Food',
      isNonFood: true,
      confidence: 0.4,
      reasons: [
        "Product name 'kernarm' does not indicate a food item.",
        'cache:hit',
      ],
    },
  });
}

describe('P2 — „kernarm" ist ein Namensqualitäts-Fragment', () => {
  it('wird als Namensqualitäts-Fragment erkannt (nicht Food, nicht Non-Food)', () => {
    expect(isNameQualityFragment(kernarm())).toBe(true);
    expect(isFragmentOrSectionHeader(kernarm())).toBe(true);
  });

  it('wird im Filtered-Bucket nie blind gerettet (keep, nicht review/rescue)', () => {
    expect(classifyFilteredOfferForRescue(kernarm())).toBe('keep');
  });

  it('aus dem sichtbaren Feed in die Quarantäne verschoben (name_quality + reviewNeeded)', () => {
    const result = applyFragmentQuarantineGate({
      offers: [kernarm()],
      nextWeekOffers: [],
      filteredOffers: [],
    });
    expect(result.offers.map((o) => o.id)).not.toContain('kernarm');
    const quarantined = result.filteredOffers.find((o) => o.id === 'kernarm');
    expect(quarantined).toBeDefined();
    expect(quarantined?.tags).toContain(NAME_QUALITY_TAG);
    expect((quarantined as Offer & { reviewNeeded?: boolean }).reviewNeeded).toBe(true);
  });
});

describe('P2 — kurze echte Food-Namen mit starker Evidenz bleiben erhalten', () => {
  it('Obst-/Getränke-Namen sind keine Fragmente', () => {
    expect(isNameQualityFragment(offer('Bananen', { canonicalCategory: { main: 'Obst', isNonFood: false } }))).toBe(false);
    expect(isNameQualityFragment(offer('Cola', {}))).toBe(false);
    // Selbst mit cache-Non-Food-Flag rettet der Food-Produktkopf den Namen.
    expect(
      isNameQualityFragment(
        offer('Milch', { canonicalCategory: { main: 'Non-Food', isNonFood: true, reasons: ['cache:hit'] } }),
      ),
    ).toBe(false);
  });

  it('eine klare Food-Quellabteilung schützt einen Einwortnamen', () => {
    const o = offer('Hausmarke', {
      foodFlag: 'unsure',
      sourceCategoryRaw: 'Molkereiprodukte',
      canonicalCategory: { main: 'Non-Food', isNonFood: true, reasons: ['cache:hit'] },
    });
    expect(isNameQualityFragment(o)).toBe(false);
  });
});

describe('P2 — echtes Non-Food und Cache-Konflikt-Food bleiben getrennt', () => {
  it('ein echtes Non-Food-Produkt (starkes Keyword) ist kein Namensfragment', () => {
    const o = offer('Livarno', { canonicalCategory: { main: 'Non-Food', isNonFood: true } });
    expect(isNameQualityFragment(o)).toBe(false);
    expect(classifyFoodDecision(o)).toBe('confirmed_non_food');
  });

  it('ein Food-Cache-Konflikt (foodFlag=food vs. cache-Non-Food) ist kein Namensfragment', () => {
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
  });
});

describe('P2 — harte Section-/CTA-/Preis-Fragmente bleiben geblockt', () => {
  it('Promo-/Packungsfragmente bleiben name_fragment', () => {
    const result = quarantineFragmentOffers([offer('Tiefpreis'), offer('l-Dose'), offer('Dose')]);
    expect(result.clean).toHaveLength(0);
    expect(result.quarantined).toHaveLength(3);
    for (const q of result.quarantined) {
      expect(q.tags).toContain('name_fragment');
    }
  });
});
