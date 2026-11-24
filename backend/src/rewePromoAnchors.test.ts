import { describe, expect, it } from 'vitest';
import {
  REWE_PROMO_ANCHORS,
  detectRewePromoAnchors,
  isReweBonusCouponContext,
  isRewePromoAnchorLine,
  isStandaloneRewePromoAnchor,
  matchRewePromoAnchor,
} from './rewePromoAnchors';

describe('REWE promo anchors', () => {
  it('recognises every configured badge word as a promo anchor line', () => {
    for (const anchor of REWE_PROMO_ANCHORS) {
      expect(isRewePromoAnchorLine(anchor)).toBe(true);
    }
  });

  it('recognises new badges beyond Aktion/Knaller', () => {
    expect(isRewePromoAnchorLine('Hammerpreis')).toBe(true);
    expect(isRewePromoAnchorLine('Kracher')).toBe(true);
    expect(isRewePromoAnchorLine('Top-Angebot')).toBe(true);
    expect(isRewePromoAnchorLine('Superpreis')).toBe(true);
  });

  it('tolerates separator and umlaut spellings (Top Angebot / Knüller)', () => {
    expect(isRewePromoAnchorLine('Top Angebot')).toBe(true);
    expect(isRewePromoAnchorLine('Knueller')).toBe(true);
    expect(isRewePromoAnchorLine('Knüller')).toBe(true);
  });

  it('does not treat ordinary product/price words as anchors', () => {
    expect(isRewePromoAnchorLine('Red Bull Energy Drink')).toBe(false);
    expect(isRewePromoAnchorLine('0,99 €')).toBe(false);
    expect(isRewePromoAnchorLine('versch. Sorten')).toBe(false);
  });

  it('matchRewePromoAnchor returns the canonical badge for a line', () => {
    expect(matchRewePromoAnchor('Hammerpreis')).toBe('Hammerpreis');
    expect(matchRewePromoAnchor('Top Angebot')).toBe('Top-Angebot');
    expect(matchRewePromoAnchor('nichts hier')).toBeNull();
  });

  it('detectRewePromoAnchors lists distinct badges found in a text', () => {
    const found = detectRewePromoAnchors(
      'Kracher\n1,99 €\nHammerpreis\n0,99 €\nKnaller\n0,49 €\nKracher\n2,49 €',
    );
    expect(found).toEqual(expect.arrayContaining(['Kracher', 'Hammerpreis', 'Knaller']));
    // "Kracher" twice → still one distinct entry.
    expect(found.filter((entry) => entry === 'Kracher')).toHaveLength(1);
  });

  it('isStandaloneRewePromoAnchor is true only when the whole line is the badge', () => {
    expect(isStandaloneRewePromoAnchor('Knaller')).toBe(true);
    expect(isStandaloneRewePromoAnchor('Hammerpreis!')).toBe(true);
    expect(isStandaloneRewePromoAnchor('Knaller Red Bull Energy Drink')).toBe(false);
  });

  it('detects REWE Bonus / Coupon / App contexts', () => {
    expect(isReweBonusCouponContext('REWE Bonus')).toBe(true);
    expect(isReweBonusCouponContext('nur mit Coupon')).toBe(true);
    expect(isReweBonusCouponContext('mit der App')).toBe(true);
    expect(isReweBonusCouponContext('versch. Sorten, koffeinhaltig')).toBe(false);
  });
});
