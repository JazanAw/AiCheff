import React from 'react';
import { Alert, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Reanimated from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { useSwipeToDismiss } from '../common/useSwipeToDismiss';
import { fontFamilies } from '../../theme';
import { Deal, SubscriptionTier } from '../../types';
import { Icon, IconName } from '../common/Icon';
import { DiscountBadge, Pill, StoreTag } from './DealBits';
import { NutritionTable } from './NutritionTable';
import { ProductThumb, thumbSeed, thumbTint } from './ProductThumb';
import { PillTone, formatEuro, formatShortDate, useDealsTheme } from './dealsTheme';

interface Props {
  deal: Deal | null;
  visible: boolean;
  tier: SubscriptionTier;
  favorite?: boolean;
  isAdded?: boolean;
  isAdding?: boolean;
  onClose: () => void;
  onAddToList?: () => void;
  onToggleFavorite?: () => void;
  onUpgrade?: () => void;
}

export function DealDetailsSheet({
  deal,
  visible,
  tier,
  favorite,
  isAdded,
  isAdding,
  onClose,
  onAddToList,
  onToggleFavorite,
  onUpgrade,
}: Props) {
  const { t } = useTranslation();
  const { colors, dark, accent } = useDealsTheme();
  const { gesture, sheetStyle, scrollHandler, scrollRef } = useSwipeToDismiss({
    visible,
    onDismiss: onClose,
  });

  if (!deal) return null;

  const seed = thumbSeed(deal.id || deal.name);
  const tint = thumbTint(deal.id || deal.name);
  const validUntil = formatShortDate(deal.validTo);
  const categoryLabel = t(`deals.categories.${deal.category}`);
  const storeLine = deal.distanceKm != null
    ? `${deal.storeName} · ${deal.distanceKm.toFixed(deal.distanceKm < 10 ? 1 : 0)} km`
    : `${deal.storeName} · ${t('deals.national')}`;

  const chips = buildProductInfoChips(deal, t);

  const showProductInfoDisclaimer = () => {
    Alert.alert(
      t('deals.productInfo.disclaimerTitle'),
      t('deals.productInfo.disclaimer'),
      [{ text: t('deals.productInfo.close') }],
    );
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <GestureHandlerRootView style={styles.root}>
      <Pressable style={[styles.backdrop, { backgroundColor: colors.overlay }]} onPress={onClose} />
      <GestureDetector gesture={gesture}>
      <Reanimated.View style={[styles.sheet, { backgroundColor: colors.background }, sheetStyle]} pointerEvents="box-none">
        <View style={[styles.sheetInner, { backgroundColor: colors.background }]}>
          <View style={styles.handleWrap}>
            <View style={[styles.handle, { backgroundColor: dark ? '#333' : '#D1D5DB' }]} />
          </View>

          <Reanimated.ScrollView
            ref={scrollRef}
            onScroll={scrollHandler}
            scrollEventThrottle={16}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.scroll}
          >
            {/* hero strip */}
            <View style={styles.hero}>
              <ProductThumb imageUrl={deal.imageUrl} seed={seed} tint={tint} size={88} />
              <View style={styles.heroBody}>
                <View style={styles.heroTop}>
                  <StoreTag name={deal.storeName} />
                  {deal.distanceKm != null && (
                    <Pill icon="pin">
                      {deal.distanceKm.toFixed(deal.distanceKm < 10 ? 1 : 0)} km · {t('deals.local')}
                    </Pill>
                  )}
                </View>
                <Text style={[styles.heroName, { color: colors.text }]} numberOfLines={3}>
                  {deal.name}
                </Text>
              </View>
              <Pressable
                onPress={onToggleFavorite}
                hitSlop={6}
                style={[styles.heart, { backgroundColor: dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }]}
              >
                <Icon name="heart" size={18} color={favorite ? colors.primary : colors.textSecondary} active={favorite} />
              </Pressable>
            </View>

            {/* price band */}
            <View style={[styles.priceBand, { backgroundColor: dark ? '#2A1A10' : '#FFF0EB', borderColor: `${colors.primary}33` }]}>
              <View style={{ flex: 1 }}>
                <View style={styles.priceRow}>
                  <Text style={[styles.priceBig, { color: colors.primary }]}>{formatEuro(deal.currentPrice)}</Text>
                  {deal.originalPrice != null && deal.originalPrice > deal.currentPrice && (
                    <Text style={[styles.priceWas, { color: colors.textTertiary }]}>{formatEuro(deal.originalPrice)}</Text>
                  )}
                </View>
                {deal.savingsAbsolute != null && (
                  <Text style={[styles.savings, { color: colors.primary }]}>
                    {t('deals.saves', { amount: formatEuro(deal.savingsAbsolute) })}
                  </Text>
                )}
              </View>
              {deal.savingsPercent != null && deal.savingsPercent > 0 && (
                <DiscountBadge value={deal.savingsPercent} variant="top" />
              )}
            </View>

            {/* meta grid */}
            <View style={styles.metaGrid}>
              <MetaTile label={t('deals.detail.validUntil')} value={validUntil ?? '—'} icon="clock" />
              <MetaTile label={t('deals.detail.category')} value={categoryLabel} icon="tag" />
              <MetaTile label={t('deals.detail.store')} value={storeLine} icon="pin" />
              <MetaTile label={t('deals.detail.availability')} value={t('deals.detail.availabilityValue')} icon="info" />
            </View>

            {/* nutrition */}
            <View style={styles.section}>
              <View style={styles.sectionHead}>
                <View style={styles.sectionTitleWrap}>
                  <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('deals.detail.nutrition')}</Text>
                  <Text style={[styles.sectionHint, { color: colors.textTertiary }]}>
                    {t('deals.detail.per100')}
                    {deal.nutritionEstimated ? ` · ${t('deals.fallback.estimated')}` : ''}
                  </Text>
                </View>
                <PlanBadge tier={tier} />
              </View>
              <NutritionTable tier={tier} nutrition={deal.nutrition} onUpgrade={onUpgrade} />
            </View>

            {/* product info — auto-detected, shown as calm chips, never guessed
                into false certainty. Long disclaimer lives behind the info icon. */}
            <View style={styles.section}>
              <View style={styles.sectionHead}>
                <View style={styles.sectionTitleWrap}>
                  <Text style={[styles.sectionTitle, { color: colors.text }]}>
                    {t('deals.productInfo.title')}
                  </Text>
                  <Pressable
                    onPress={showProductInfoDisclaimer}
                    hitSlop={10}
                    accessibilityRole="button"
                    accessibilityLabel={t('deals.productInfo.infoA11y')}
                    style={[styles.infoBtn, { backgroundColor: dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)' }]}
                  >
                    <Icon name="info" size={13} color={colors.textSecondary} />
                  </Pressable>
                </View>
              </View>
              <View style={styles.propPills}>
                {chips.length > 0 ? (
                  chips.map((chip) => (
                    <Pill key={chip.key} tone={chip.tone} icon={chip.icon}>
                      {chip.label}
                    </Pill>
                  ))
                ) : (
                  <Text style={[styles.noProps, { color: colors.textTertiary }]}>
                    {t('deals.productInfo.none')}
                  </Text>
                )}
              </View>
            </View>
          </Reanimated.ScrollView>

          {/* sticky CTA */}
          <View style={[styles.cta, { borderTopColor: colors.borderLight, backgroundColor: colors.background }]}>
            <Pressable onPress={onToggleFavorite} style={[styles.ctaGhost, { borderColor: colors.border }]}>
              <Icon name="heart" size={16} color={colors.text} active={favorite} />
              <Text style={[styles.ctaGhostText, { color: colors.text }]}>{t('deals.detail.remember')}</Text>
            </Pressable>
            <Pressable
              onPress={onAddToList}
              disabled={isAdded || isAdding}
              style={[styles.ctaPrimary, { backgroundColor: isAdded ? colors.surface : accent, opacity: isAdding ? 0.6 : 1 }]}
            >
              <Icon name={isAdded ? 'check' : 'cart-plus'} size={18} color={isAdded ? colors.textSecondary : '#fff'} active={!isAdded} />
              <Text style={[styles.ctaPrimaryText, { color: isAdded ? colors.textSecondary : '#fff' }]}>
                {isAdded ? t('deals.addedToList') : t('deals.detail.addToList')}
              </Text>
            </Pressable>
          </View>
        </View>
      </Reanimated.View>
      </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

interface ProductInfoChip {
  key: string;
  label: string;
  tone?: PillTone;
  icon?: IconName;
}

/**
 * Build the "Produktinfos" chips from auto-detected data. Rules (honest, never
 * fabricated): explicit diet flags only when true; halal stays "unklar" unless
 * confirmed; alcohol flagged when present; allergens shown when known or as a
 * "risk" hint; nutrition shown as estimated / missing. Unknown allergen status
 * yields NO chip — we never imply "allergen-free".
 */
function buildProductInfoChips(
  deal: Deal,
  t: (key: string) => string,
): ProductInfoChip[] {
  const chips: ProductInfoChip[] = [];

  if (deal.isVegan === true) {
    chips.push({ key: 'vegan', label: t('deals.productInfo.vegan'), tone: 'trend', icon: 'leaf' });
  } else if (deal.isVegetarian === true) {
    chips.push({ key: 'vegetarian', label: t('deals.productInfo.vegetarian'), tone: 'trend', icon: 'leaf' });
  }

  switch (deal.halalStatus) {
    case 'halal':
      chips.push({ key: 'halal', label: t('deals.productInfo.halalLikely'), tone: 'trend', icon: 'leaf' });
      break;
    case 'not_halal':
      chips.push({ key: 'halal', label: t('deals.productInfo.notHalal') });
      break;
    case 'doubtful':
    case 'unknown':
    default:
      chips.push({ key: 'halal', label: t('deals.productInfo.halalUnclear'), icon: 'info' });
      break;
  }

  if (deal.containsAlcohol === true) {
    chips.push({ key: 'alcohol', label: t('deals.productInfo.containsAlcohol') });
  }

  if (deal.allergenStatus === 'known' && (deal.allergens?.length ?? 0) > 0) {
    for (const allergen of deal.allergens ?? []) {
      chips.push({ key: `allergen-${allergen}`, label: t(`onboarding.allergy${capitalize(allergen)}`) });
    }
  } else if (deal.allergenStatus === 'risk') {
    chips.push({ key: 'allergen-risk', label: t('deals.productInfo.allergenRisk'), icon: 'info' });
  }

  if (deal.nutritionStatus === 'estimated') {
    chips.push({ key: 'nutrition-estimated', label: t('deals.productInfo.nutritionEstimated'), icon: 'info' });
  } else if (deal.nutritionStatus === 'unknown') {
    chips.push({ key: 'nutrition-none', label: t('deals.productInfo.noNutrition') });
  }

  return chips;
}

function MetaTile({ label, value, icon }: { label: string; value: string; icon: IconName }) {
  const { colors, dark } = useDealsTheme();
  return (
    <View style={[styles.metaTile, { backgroundColor: dark ? '#1A1A1A' : '#F8F9FA', borderColor: colors.border }]}>
      <View style={styles.metaLabelWrap}>
        <Icon name={icon} size={11} color={colors.textTertiary} />
        <Text style={[styles.metaLabel, { color: colors.textTertiary }]}>{label}</Text>
      </View>
      <Text style={[styles.metaValue, { color: colors.text }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function PlanBadge({ tier }: { tier: SubscriptionTier }) {
  const { t } = useTranslation();
  const { pill } = useDealsTheme();
  const map = {
    free: { label: `${t('subscription.free')} · Basis`, ...pill.default },
    plus: { label: `${t('subscription.plus')}`, ...pill.trend },
    premium: { label: `${t('subscription.premium')}`, ...pill.locked },
  } as const;
  const m = map[tier];
  return (
    <View style={[styles.planBadge, { backgroundColor: m.bg, borderColor: m.border }]}>
      <Text style={[styles.planBadgeText, { color: m.fg }]}>{m.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  backdrop: { ...StyleSheet.absoluteFillObject },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '90%', borderTopLeftRadius: 20, borderTopRightRadius: 20, overflow: 'hidden' },
  sheetInner: { paddingBottom: 8 },
  handleWrap: { alignItems: 'center', paddingTop: 8, paddingBottom: 6 },
  handle: { width: 36, height: 4, borderRadius: 2 },
  scroll: { paddingBottom: 12 },
  hero: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingTop: 6 },
  heroBody: { flex: 1, minWidth: 0 },
  heroTop: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  heroName: { fontFamily: fontFamilies.displaySemibold, fontSize: 19, letterSpacing: -0.3, marginTop: 4, lineHeight: 22 },
  heart: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  priceBand: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginHorizontal: 20, marginTop: 14, paddingHorizontal: 16, paddingVertical: 14, borderRadius: 14, borderWidth: 1 },
  priceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  priceBig: { fontFamily: fontFamilies.displayBold, fontSize: 30, letterSpacing: -0.8, lineHeight: 32 },
  priceWas: { fontSize: 13, textDecorationLine: 'line-through', fontFamily: fontFamilies.medium },
  savings: { fontSize: 11, fontFamily: fontFamilies.semibold, marginTop: 4 },
  metaGrid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 20, marginTop: 14, gap: 8 },
  metaTile: { width: '48%', flexGrow: 1, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, borderWidth: 1 },
  metaLabelWrap: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaLabel: { fontSize: 10.5, fontFamily: fontFamilies.semibold, letterSpacing: 0.4, textTransform: 'uppercase' },
  metaValue: { fontSize: 13.5, fontFamily: fontFamilies.semibold, marginTop: 3, letterSpacing: -0.1 },
  section: { paddingHorizontal: 20, marginTop: 18 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  sectionTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  sectionTitle: { fontFamily: fontFamilies.displaySemibold, fontSize: 17, letterSpacing: -0.3 },
  infoBtn: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  sectionHint: { fontSize: 11, fontFamily: fontFamilies.medium, flexShrink: 1 },
  propPills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  noProps: { fontSize: 12.5, fontFamily: fontFamilies.regular },
  planBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, borderWidth: 1 },
  planBadgeText: { fontSize: 11, fontFamily: fontFamilies.bold, letterSpacing: 0.3 },
  cta: { flexDirection: 'row', gap: 8, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4, borderTopWidth: 1 },
  ctaGhost: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 14, borderRadius: 12, borderWidth: 1 },
  ctaGhostText: { fontSize: 14, fontFamily: fontFamilies.semibold },
  ctaPrimary: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, borderRadius: 12 },
  ctaPrimaryText: { fontSize: 15, fontFamily: fontFamilies.bold, letterSpacing: -0.1 },
});
