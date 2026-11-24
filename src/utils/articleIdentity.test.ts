import { describe, expect, it } from 'vitest';
import type { Offer } from '../types/models';
import {
  ARTICLE_ID_VERSION,
  articleFamilyKeyForOffer,
  articleIdForOffer,
  offersForArticleId,
  withArticleId,
} from './articleIdentity';

function offer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: 'offer-aldi-week-1',
    name: 'Müller Milch Schoko 400 ml',
    normalizedName: 'muller milch schoko 400 ml',
    brand: 'Müller',
    storeChain: 'ALDI NORD',
    category: 'Milchprodukte',
    price: 1.29,
    currency: 'EUR',
    unit: '400 ml',
    validityStart: '2026-08-17',
    validityEnd: '2026-08-22',
    sourceUrl: 'https://example.com/aldi',
    tags: [],
    createdAt: '2026-08-17T00:00:00.000Z',
    ...overrides,
  };
}

describe('article family identity', () => {
  it('groups varieties, stores, weeks and package sizes under one articleId', () => {
    const chocolate = offer();
    const strawberry = offer({
      id: 'offer-rewe-week-2',
      name: 'Müller Milch Erdbeere 1 l',
      normalizedName: 'muller milch erdbeere 1 l',
      storeChain: 'REWE',
      price: 1.79,
      unit: '1 l',
      validityStart: '2026-08-24',
      validityEnd: '2026-08-29',
    });

    expect(articleFamilyKeyForOffer(chocolate)).toBe('family:mueller milch');
    expect(articleIdForOffer(chocolate)).toBe(articleIdForOffer(strawberry));
    expect(chocolate.id).not.toBe(strawberry.id);
  });

  it('groups common pizza varieties but keeps distinct product lines separate', () => {
    const salami = offer({
      name: 'Dr. Oetker Ristorante Pizza Salame',
      normalizedName: 'dr oetker ristorante pizza salame',
      brand: 'Dr. Oetker',
    });
    const funghi = offer({
      name: 'Dr. Oetker Ristorante Pizza Funghi',
      normalizedName: 'dr oetker ristorante pizza funghi',
      brand: 'Dr. Oetker',
    });
    const backmischung = offer({
      name: 'Dr. Oetker Ristorante Backmischung',
      normalizedName: 'dr oetker ristorante backmischung',
      brand: 'Dr. Oetker',
    });

    expect(articleIdForOffer(salami)).toBe(articleIdForOffer(funghi));
    expect(articleIdForOffer(salami)).not.toBe(articleIdForOffer(backmischung));
  });

  it('does not collapse unrelated articles from the same brand', () => {
    const milk = offer();
    const yoghurt = offer({
      name: 'Müller Joghurt Schoko 400 g',
      normalizedName: 'muller joghurt schoko 400 g',
    });
    expect(articleIdForOffer(milk)).not.toBe(articleIdForOffer(yoghurt));
  });

  it('keeps a compound product type such as pasta sauce separate from pasta', () => {
    const pasta = offer({
      name: 'BARILLA Pasta Spaghetti',
      normalizedName: 'barilla pasta spaghetti',
      brand: 'BARILLA',
    });
    const sauce = offer({
      name: 'BARILLA Pasta-Sauce Tomate',
      normalizedName: 'barilla pasta sauce tomate',
      brand: 'BARILLA',
    });
    expect(articleIdForOffer(pasta)).not.toBe(articleIdForOffer(sauce));
  });

  it('groups arbitrary trailing variety names after a clear product type', () => {
    const seaBlue = offer({
      name: 'RED BULL Energy Drink Sea Blue Edition',
      normalizedName: 'red bull energy drink sea blue edition',
      brand: 'RED BULL',
    });
    const tropical = offer({
      name: 'RED BULL Energy Drink Tropical Guava',
      normalizedName: 'red bull energy drink tropical guava',
      brand: 'RED BULL',
    });

    expect(articleFamilyKeyForOffer(seaBlue)).toBe('family:red bull energy drink');
    expect(articleIdForOffer(seaBlue)).toBe(articleIdForOffer(tropical));
  });

  it('survives missing brand fields and compound product-type spelling', () => {
    const explicitBrand = offer({
      name: 'RED BULL Energy Drink Classic',
      normalizedName: 'red bull energy drink classic',
      brand: 'RED BULL',
    });
    const embeddedBrand = offer({
      name: 'RED BULL Energydrink White Edition',
      normalizedName: 'red bull energydrink white edition',
      brand: undefined,
    });

    expect(articleIdForOffer(explicitBrand)).toBe(articleIdForOffer(embeddedBrand));
  });

  it('groups a brand-only product with its named varieties', () => {
    const original = offer({
      name: 'COCA-COLA Original',
      normalizedName: 'coca cola original',
      brand: 'COCA-COLA',
    });
    const zero = offer({
      name: 'COCA-COLA Zero',
      normalizedName: 'coca cola zero',
      brand: 'COCA-COLA',
    });
    expect(articleIdForOffer(original)).toBe(articleIdForOffer(zero));
  });

  it('keeps a standalone variety word as a real unbranded article', () => {
    const mango = offer({ name: 'Mango', normalizedName: 'mango', brand: undefined });
    expect(articleFamilyKeyForOffer(mango)).toBe('family:mango');
  });

  it('preserves an already issued versioned id', () => {
    const existing = `${ARTICLE_ID_VERSION}_0123456789abcdef`;
    expect(withArticleId(offer({ articleId: existing })).articleId).toBe(existing);
  });

  it('finds every concrete offer belonging to a favourite articleId', () => {
    const aldi = withArticleId(offer());
    const rewe = withArticleId(
      offer({
        id: 'offer-rewe',
        name: 'Müller Milch Vanille',
        normalizedName: 'muller milch vanille',
        storeChain: 'REWE',
      }),
    );
    const other = withArticleId(
      offer({ id: 'other', name: 'Müller Joghurt', normalizedName: 'muller joghurt' }),
    );

    expect(offersForArticleId([aldi, rewe, other], aldi.articleId ?? '').map((item) => item.id)).toEqual([
      'offer-aldi-week-1',
      'offer-rewe',
    ]);
  });
});
