import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { fontFamilies } from '../../theme';
import { Deal } from '../../types';
import { Icon } from '../common/Icon';
import { DiscountBadge, FavoriteButton, Pill, StoreTag } from './DealBits';
import { ProductThumb, thumbSeed, thumbTint } from './ProductThumb';
import { formatEuro, formatShortDate, useDealsTheme } from './dealsTheme';
import type { OfferReasonTag } from '../../utils/offerRanking';
import { OFFER_REASON_I18N, getOfferReasonBadges } from '../../utils/reasonBadges';

export type DealCardVariant = 'normal' | 'top' | 'trend' | 'locked';

interface Props {
  deal: Deal;
  variant?: DealCardVariant;
  /** Whether kcal can be shown (subscription gate). When false the kcal pill
   *  is replaced by a "Plus für Nährwerte" lock pill. */
  canSeeNutrition?: boolean;
  favorite?: boolean;
  isAdded?: boolean;
  isAdding?: boolean;
  /** Extra primary pill, e.g. "Spart 1,50 €". Ignored for the trend variant. */
  badge?: string;
  /** Hybrid-ranking reason tags. Up to 2 are shown as small "why" pills.
   *  Absent/empty → nothing rendered (cards elsewhere look unchanged). */
  reasonTags?: OfferReasonTag[];
  onPress?: () => void;
  onAddToList?: () => void;
  onToggleFavorite?: () => void;
}

export function DealCard({
  deal,
  variant = 'normal',
  canSeeNutrition = false,
  favorite = false,
  isAdded = false,
  isAdding = false,
  badge,
  reasonTags,
  onPress,
  onAddToList,
  onToggleFavorite,
}: Props) {
  const { t } = useTranslation();
  const { colors, dark, accent } = useDealsTheme();

  const isTop = variant === 'top';
  const isTrend = variant === 'trend';
  const locked = variant === 'locked';

  const seed = thumbSeed(deal.id || deal.name);
  const tint = thumbTint(deal.id || deal.name);
  const validUntil = formatShortDate(deal.validTo);
  const kcal = deal.nutrition?.calories;
  const reasonBadges = getOfferReasonBadges(reasonTags);

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: colors.surfaceElevated,
          borderColor: isTop ? colors.primary : colors.border,
          borderWidth: isTop ? 1.5 : 1,
          shadowColor: isTop ? colors.primary : '#000',
          shadowOpacity: isTop ? (dark ? 0.35 : 0.1) : 0,
          shadowRadius: isTop ? 16 : 0,
          shadowOffset: { width: 0, height: 6 },
          elevation: isTop ? 4 : 0,
        },
      ]}
    >
      <ProductThumb imageUrl={deal.imageUrl} seed={seed} tint={tint} size={88} />

      <View style={styles.content}>
        {/* row 1: store + badges */}
        <View style={styles.topRow}>
          <View style={styles.storeMeta}>
            <StoreTag name={deal.storeName} />
            <Text style={[styles.meta, { color: colors.textTertiary }]} numberOfLines={1}>
              {deal.distanceKm != null
                ? `· ${deal.distanceKm.toFixed(deal.distanceKm < 10 ? 1 : 0)} km`
                : `· ${t('deals.national')}`}
            </Text>
          </View>
          <View style={styles.badgeRow}>
            {deal.savingsPercent != null && deal.savingsPercent > 0 && (
              <DiscountBadge value={deal.savingsPercent} variant={isTop ? 'top' : 'default'} />
            )}
            <FavoriteButton active={favorite} onPress={onToggleFavorite} />
          </View>
        </View>

        {/* row 2: name */}
        <Text style={[styles.name, { color: colors.text }]} numberOfLines={2}>
          {deal.name}
        </Text>

        {/* row 3: price */}
        <View style={styles.priceRow}>
          <Text style={[styles.priceNow, { color: colors.text }]}>{formatEuro(deal.currentPrice)}</Text>
          {deal.originalPrice != null && deal.originalPrice > deal.currentPrice && (
            <Text style={[styles.priceWas, { color: colors.textTertiary }]}>
              {formatEuro(deal.originalPrice)}
            </Text>
          )}
        </View>

        {/* row 4: pills */}
        <View style={styles.pills}>
          {/* "Warum" — up to 2 ranking reasons, only when provided. */}
          {reasonBadges.map((tag) => (
            <Pill key={`reason-${tag}`} tone="primary">
              {t(OFFER_REASON_I18N[tag])}
            </Pill>
          ))}
          {validUntil && (
            <Pill icon="clock">{t('deals.validUntilShort', { date: validUntil })}</Pill>
          )}
          {isTrend && (
            <Pill icon="trend-up" tone="trend">
              {t('deals.trendBadge')}
            </Pill>
          )}
          {badge && !isTrend && (
            <Pill icon="flash" tone="primary">
              {badge}
            </Pill>
          )}
          {locked || !canSeeNutrition ? (
            kcal != null ? (
              <Pill icon="lock" tone="locked">
                {t('deals.fallback.lockedNutrition')}
              </Pill>
            ) : null
          ) : (
            kcal != null && <Pill>{kcal} kcal</Pill>
          )}
        </View>

        {/* row 5: actions */}
        <View style={styles.actions}>
          <Pressable
            onPress={onPress}
            style={[styles.detailsBtn, { borderColor: colors.border }]}
          >
            <Icon name="info" size={15} color={colors.textSecondary} />
            <Text style={[styles.detailsText, { color: colors.textSecondary }]}>
              {t('deals.details')}
            </Text>
          </Pressable>
          <Pressable
            onPress={onAddToList}
            disabled={isAdded || isAdding}
            style={[
              styles.cartBtn,
              {
                backgroundColor: isAdded ? colors.surface : accent,
                borderWidth: isAdded ? 1 : 0,
                borderColor: colors.border,
                opacity: isAdding ? 0.6 : 1,
              },
            ]}
          >
            <Icon
              name={isAdded ? 'check' : 'cart-plus'}
              size={15}
              color={isAdded ? colors.textSecondary : '#fff'}
              active={!isAdded}
            />
            <Text style={[styles.cartText, { color: isAdded ? colors.textSecondary : '#fff' }]}>
              {isAdded ? t('deals.addedToList') : t('deals.addToList')}
            </Text>
          </Pressable>
        </View>
      </View>

      {/* "TOP" corner ribbon */}
      {isTop && (
        <View style={[styles.ribbon, { backgroundColor: colors.primary }]}>
          <Text style={styles.ribbonText}>★ {t('deals.filters.top')}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: 'relative',
    flexDirection: 'row',
    gap: 12,
    borderRadius: 14,
    padding: 12,
  },
  content: { flex: 1, minWidth: 0 },
  topRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 4 },
  storeMeta: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  meta: { fontSize: 11, fontFamily: fontFamilies.medium, flexShrink: 1 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { fontSize: 15, fontFamily: fontFamilies.bold, lineHeight: 19, letterSpacing: -0.15, marginTop: 1 },
  priceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 6 },
  priceNow: { fontFamily: fontFamilies.displayBold, fontSize: 22, letterSpacing: -0.5, lineHeight: 24 },
  priceWas: { fontSize: 12.5, fontFamily: fontFamilies.medium, textDecorationLine: 'line-through' },
  pills: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' },
  actions: { flexDirection: 'row', gap: 8, marginTop: 10 },
  detailsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  detailsText: { fontSize: 13, fontFamily: fontFamilies.semibold },
  cartBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  cartText: { fontSize: 13, fontFamily: fontFamilies.bold, letterSpacing: -0.1 },
  ribbon: {
    position: 'absolute',
    top: 0,
    left: 12,
    paddingHorizontal: 8,
    paddingTop: 3,
    paddingBottom: 4,
    borderBottomLeftRadius: 5,
    borderBottomRightRadius: 5,
  },
  ribbonText: {
    fontSize: 9.5,
    fontFamily: fontFamilies.extrabold,
    letterSpacing: 0.6,
    color: '#fff',
    textTransform: 'uppercase',
  },
});
