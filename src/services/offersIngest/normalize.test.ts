import { describe, expect, it } from 'vitest';
import { normalizeOffers } from './normalize';
import { RawOfferCandidate } from './types';

describe('normalizeOffers', () => {
  it('normalisiert Preise, Datum und Tags', () => {
    const rawOffers: RawOfferCandidate[] = [
      {
        name: 'Bio Bananen',
        storeChain: 'Aldi',
        category: 'Obst/Gem\u00fcse',
        price: '1,29',
        currency: 'EUR',
        unit: 'kg',
        validityStart: '03.02.2026',
        validityEnd: '09.02.2026',
        sourceUrl: 'https://example.org/a',
        tags: ['Vegan', 'Bio'],
      },
    ];

    const [offer] = normalizeOffers(rawOffers);
    expect(offer).toBeDefined();
    expect(offer.articleId).toMatch(/^article_v3_[0-9a-f]{16}$/);
    expect(offer.price).toBe(1.29);
    expect(offer.currency).toBe('EUR');
    expect(offer.unit).toBe('kg');
    expect(offer.category).toBe('Obst/Gem\u00fcse');
    expect(offer.tags).toEqual(['vegan', 'bio']);
    expect(offer.validityStart.startsWith('2026-02-03')).toBe(true);
    expect(offer.validityEnd.startsWith('2026-02-09')).toBe(true);
  });

  it('entfernt Duplikate ueber Store, Normalized Name und Startdatum', () => {
    const rawOffers: RawOfferCandidate[] = [
      {
        name: 'Basmatireis',
        storeChain: 'Rewe',
        category: 'Trockenware',
        price: '2,79',
        unit: 'kg',
        validityStart: '03.02.2026',
        validityEnd: '09.02.2026',
        sourceUrl: 'https://example.org/b',
      },
      {
        name: 'Basmatireis',
        storeChain: 'Rewe',
        category: 'Trockenware',
        price: '2,79',
        unit: 'kg',
        validityStart: '03.02.2026',
        validityEnd: '09.02.2026',
        sourceUrl: 'https://example.org/b',
      },
    ];

    const offers = normalizeOffers(rawOffers);
    expect(offers).toHaveLength(1);
  });

  it('behält die Rohsignale (sourceCategoryRaw/Department/Tags/Context) für die KI', () => {
    const rawOffers: RawOfferCandidate[] = [
      {
        name: 'Ayran Getränk',
        storeChain: 'Kaufland',
        category: 'Internationale Kühlung',
        sourceCategoryRaw: 'Internationale Kühlung',
        sourceDepartmentRaw: 'Türkische Spezialitäten',
        sourceTagsRaw: ['Aktion', 'International'],
        sourceContextRaw: 'Türkisches Joghurtgetränk, 250 ml',
        price: '0,79',
        unit: '250ml',
        validityStart: '03.02.2026',
        validityEnd: '09.02.2026',
        sourceUrl: 'https://example.org/ayran',
      },
    ];

    const [offer] = normalizeOffers(rawOffers);
    expect(offer).toBeDefined();
    // Simple category is still collapsed for Mobile/Admin — never broken.
    expect(typeof offer.category).toBe('string');
    // Raw signals survive normalization so the KI/classification can use them.
    expect(offer.sourceCategoryRaw).toBe('Internationale Kühlung');
    expect(offer.sourceDepartmentRaw).toBe('Türkische Spezialitäten');
    expect(offer.sourceTagsRaw).toEqual(['Aktion', 'International']);
    expect(offer.sourceContextRaw).toBe('Türkisches Joghurtgetränk, 250 ml');
  });

  it('lässt Rohsignal-Felder weg, wenn die Quelle keine liefert', () => {
    const [offer] = normalizeOffers([
      {
        name: 'Bio Bananen',
        storeChain: 'Aldi',
        category: 'Obst/Gemüse',
        price: '1,29',
        unit: 'kg',
        validityStart: '03.02.2026',
        validityEnd: '09.02.2026',
        sourceUrl: 'https://example.org/a',
      },
    ]);
    expect(offer.sourceCategoryRaw).toBeUndefined();
    expect(offer.sourceTagsRaw).toBeUndefined();
  });

  it('vereinheitlicht freie Kategorien auf das einfache Kategorie-Set', () => {
    const rawOffers: RawOfferCandidate[] = [
      {
        name: 'Red Bull Energy Drink',
        storeChain: 'Rewe',
        category: 'Energy / Softdrinks',
        price: '1,29',
        unit: '250ml',
        validityStart: '03.02.2026',
        validityEnd: '09.02.2026',
        sourceUrl: 'https://example.org/c',
      },
      {
        name: 'Pils Bier',
        storeChain: 'Rewe',
        category: 'Bier',
        price: '0,99',
        unit: '500ml',
        validityStart: '03.02.2026',
        validityEnd: '09.02.2026',
        sourceUrl: 'https://example.org/d',
      },
      {
        name: 'Pizza Salami Tiefkuehl',
        storeChain: 'Rewe',
        category: 'Tiefk\u00fchlkost',
        price: '2,49',
        unit: '400g',
        validityStart: '03.02.2026',
        validityEnd: '09.02.2026',
        sourceUrl: 'https://example.org/e',
      },
    ];

    const offers = normalizeOffers(rawOffers);
    expect(offers).toHaveLength(3);
    expect(offers[0].category).toBe('Alkohol');
    expect(offers[1].category).toBe('Getr\u00e4nke Alkoholfrei');
    expect(offers[2].category).toBe('Tiefk\u00fchl');
  });
});
