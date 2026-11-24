import React, { useMemo } from 'react';
import {
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { ListRenderItem } from 'react-native';
import { useTranslation } from 'react-i18next';
import { fontFamilies, spacing, useThemeColors } from '../../theme';
import type { ThemeColors } from '../../theme';
import { Icon } from '../../components/common/Icon';
import type { IconName } from '../../components/common/Icon';
import { RecipeIllustration } from '../../components/common/RecipeIllustration';
import { getCuisineLabel, normalizeCuisine } from '../../utils/cuisine';
import {
  rankRecipesWithOffers,
  recipeOfferInfo,
  type RecipeOfferInfo,
} from '../../utils/offerRecipes';
import type { PantryItem, Recipe } from '../../types';

type TFunc = (k: string, opts?: Record<string, unknown>) => string;

interface Props {
  /** Recipes for this tab (already cuisine-filtered by the parent). */
  recipes: Recipe[];
  pantryItems: PantryItem[];
  /** Vertical offset to clear the header/tab chrome above. */
  contentTopInset: number;
  bottomInset: number;
  /** Whether a cuisine chip (other than "Alle") is currently active. */
  filterActive: boolean;
  /** Reset the cuisine filter to "Alle" (empty-state CTA). */
  onResetFilter: () => void;
  /** Switch to the "Für dich" tab (empty-state CTA). */
  onGoForYou: () => void;
  onOpenRecipe: (recipe: Recipe) => void;
  /** Open the "Zum Wochenplan" sheet for a recipe. */
  onPlanRecipe: (recipe: Recipe) => void;
}

/**
 * "Mit Angeboten" tab — a calm recipe LIST (no swipe) led by the current
 * offers attached to each recipe's ingredients. Ranking + expired-deal handling
 * live in the pure `offerRecipes` util; this component is presentation only.
 */
export function OfferRecipesView({
  recipes,
  pantryItems,
  contentTopInset,
  bottomInset,
  filterActive,
  onResetFilter,
  onGoForYou,
  onOpenRecipe,
  onPlanRecipe,
}: Props) {
  const colors = useThemeColors();
  const { t } = useTranslation();

  const ranked = useMemo(
    () => rankRecipesWithOffers(recipes, pantryItems),
    [recipes, pantryItems],
  );

  // Empty-state kind: an active cuisine filter that hides everything is a
  // "no match", otherwise distinguish "all offers expired" from "no offers".
  const anyExpired = useMemo(
    () => recipes.some((r) => recipeOfferInfo(r, pantryItems).hasExpiredDeals),
    [recipes, pantryItems],
  );

  const renderItem: ListRenderItem<(typeof ranked)[number]> = ({ item }) => (
    <OfferRecipeCard
      recipe={item.recipe}
      offer={item.offer}
      colors={colors}
      t={t}
      onOpen={() => onOpenRecipe(item.recipe)}
      onPlan={() => onPlanRecipe(item.recipe)}
    />
  );

  return (
    <FlatList
      data={ranked}
      keyExtractor={(item) => item.recipe.id}
      renderItem={renderItem}
      ListHeaderComponent={
        ranked.length > 0 ? (
          <View style={headerStyles.wrap}>
            <Text style={[headerStyles.title, { color: colors.text }]}>
              {t('cheffity.offers.screenTitle')}
            </Text>
            <Text style={[headerStyles.sub, { color: colors.textSecondary }]}>
              {t('cheffity.offers.headerSubline')}
            </Text>
          </View>
        ) : null
      }
      ListEmptyComponent={
        <OfferEmptyState
          colors={colors}
          t={t}
          kind={filterActive ? 'noMatch' : anyExpired ? 'expired' : 'noOffers'}
          onResetFilter={onResetFilter}
          onGoForYou={onGoForYou}
        />
      }
      contentContainerStyle={{
        paddingTop: contentTopInset,
        paddingBottom: bottomInset + spacing.xl,
        paddingHorizontal: spacing.md,
      }}
      ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
      showsVerticalScrollIndicator={false}
    />
  );
}

const headerStyles = StyleSheet.create({
  wrap: { paddingTop: spacing.xs, paddingBottom: spacing.md, paddingHorizontal: 4 },
  title: {
    fontFamily: fontFamilies.displaySemibold,
    fontSize: 24,
    lineHeight: 28,
    letterSpacing: -0.5,
  },
  sub: {
    marginTop: 4,
    fontSize: 13.5,
    fontFamily: fontFamilies.medium,
  },
});

// ─── Offer-led recipe card (mirrors the design's OfferRecipeCard) ───────────

function OfferRecipeCard({
  recipe,
  offer,
  colors,
  t,
  onOpen,
  onPlan,
}: {
  recipe: Recipe;
  offer: RecipeOfferInfo;
  colors: ThemeColors;
  t: TFunc;
  onOpen: () => void;
  onPlan: () => void;
}) {
  const costStr =
    offer.missingCost != null
      ? offer.missingCost.toFixed(2).replace('.', ',')
      : null;
  const missingText =
    offer.missingCount === 0
      ? t('cheffity.offers.allInPantry')
      : costStr != null
        ? t('cheffity.offers.missingWithCost', { count: offer.missingCount, cost: costStr })
        : t('cheffity.offers.missing', { count: offer.missingCount });

  return (
    <View
      style={[
        cardStyles.card,
        { backgroundColor: colors.surfaceElevated, borderColor: colors.borderLight },
      ]}
    >
      {/* head: thumb + name + meta */}
      <View style={cardStyles.head}>
        <View style={cardStyles.thumb}>
          {recipe.imageUrl ? (
            <Image source={{ uri: recipe.imageUrl }} style={cardStyles.thumbImage} />
          ) : (
            <View style={cardStyles.thumbIllustration}>
              <RecipeIllustration recipeId={recipe.id} />
            </View>
          )}
        </View>
        <View style={cardStyles.titleBlock}>
          <Text style={[cardStyles.title, { color: colors.text }]} numberOfLines={2}>
            {recipe.name}
          </Text>
          <View style={cardStyles.metaRow}>
            <View style={cardStyles.metaItem}>
              <Icon name="clock" size={12} color={colors.textSecondary} />
              <Text style={[cardStyles.metaText, { color: colors.textSecondary }]}>
                {t('cheffity.cookTime', { minutes: recipe.cookTimeMinutes })}
              </Text>
            </View>
            {recipe.cuisine ? (
              <Text style={[cardStyles.metaText, { color: colors.textSecondary }]} numberOfLines={1}>
                {getCuisineLabel(normalizeCuisine(recipe.cuisine), t)}
              </Text>
            ) : null}
            <View style={cardStyles.metaItem}>
              <Icon name="profile" size={12} color={colors.textSecondary} />
              <Text style={[cardStyles.metaText, { color: colors.textSecondary }]}>
                {t('planner.entrySheet.portions', { count: recipe.servings })}
              </Text>
            </View>
          </View>
        </View>
      </View>

      {/* offer line — hairline divider, no nested card */}
      <View style={[cardStyles.offerBlock, { borderTopColor: colors.borderLight }]}>
        <View style={cardStyles.offerRow}>
          <View style={[cardStyles.dealPill, { backgroundColor: colors.accentLight }]}>
            <Icon name="tag" size={13} color={colors.accent} active />
            <Text style={[cardStyles.dealPillText, { color: colors.accent }]} numberOfLines={1}>
              {t('cheffity.pantryView.statOnDeal', { count: offer.validDealCount })}
            </Text>
          </View>
          {offer.stores.map((store) => (
            <View
              key={store}
              style={[cardStyles.storeBadge, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}
            >
              <Text style={[cardStyles.storeText, { color: colors.textSecondary }]} numberOfLines={1}>
                {store}
              </Text>
            </View>
          ))}
        </View>
        <View style={cardStyles.missingRow}>
          <Icon name="cart-plus" size={13} color={colors.textTertiary} />
          <Text style={[cardStyles.missingText, { color: colors.textSecondary }]} numberOfLines={1}>
            {missingText}
          </Text>
        </View>
      </View>

      {/* actions */}
      <View style={cardStyles.actions}>
        <Pressable
          onPress={onOpen}
          style={[cardStyles.secondaryBtn, { borderColor: colors.border, backgroundColor: colors.surface }]}
          accessibilityRole="button"
          accessibilityLabel={t('cheffity.details')}
        >
          <Icon name="info" size={16} color={colors.text} />
          <Text style={[cardStyles.secondaryBtnText, { color: colors.text }]}>
            {t('cheffity.details')}
          </Text>
        </Pressable>
        <Pressable
          onPress={onPlan}
          style={[cardStyles.primaryBtn, { backgroundColor: colors.primary }]}
          accessibilityRole="button"
          accessibilityLabel={t('cheffity.offers.plan')}
        >
          <Icon name="plan" size={16} color="#FFFFFF" />
          <Text style={cardStyles.primaryBtnText}>{t('cheffity.offers.plan')}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const cardStyles = StyleSheet.create({
  card: { borderRadius: 16, borderWidth: 1, padding: 14, gap: 12 },
  head: { flexDirection: 'row', gap: 12 },
  thumb: {
    width: 58,
    height: 58,
    borderRadius: 13,
    overflow: 'hidden',
    backgroundColor: '#000',
    flexShrink: 0,
  },
  thumbImage: { width: '100%', height: '100%', resizeMode: 'cover' },
  thumbIllustration: { ...StyleSheet.absoluteFillObject, transform: [{ scale: 1.25 }] },
  titleBlock: { flex: 1, minWidth: 0, gap: 6 },
  title: {
    fontFamily: fontFamilies.displaySemibold,
    fontSize: 16.5,
    lineHeight: 20,
    letterSpacing: -0.2,
  },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10 },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaText: { fontSize: 12.5, fontFamily: fontFamilies.medium },
  offerBlock: { borderTopWidth: 1, paddingTop: 11, gap: 9 },
  offerRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  dealPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 999,
    flexShrink: 1,
  },
  dealPillText: { fontSize: 12, fontFamily: fontFamilies.bold, letterSpacing: -0.1 },
  storeBadge: {
    paddingVertical: 4,
    paddingHorizontal: 9,
    borderRadius: 8,
    borderWidth: 1,
  },
  storeText: { fontSize: 11.5, fontFamily: fontFamilies.semibold },
  missingRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  missingText: { flex: 1, fontSize: 12.5, fontFamily: fontFamilies.semibold, letterSpacing: -0.1 },
  actions: { flexDirection: 'row', gap: 8 },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 11,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
  },
  secondaryBtnText: { fontSize: 14, fontFamily: fontFamilies.semibold },
  primaryBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 11,
    borderRadius: 12,
  },
  primaryBtnText: { color: '#FFFFFF', fontSize: 14, fontFamily: fontFamilies.bold },
});

// ─── Empty / info states ────────────────────────────────────────────────────

function OfferEmptyState({
  colors,
  t,
  kind,
  onResetFilter,
  onGoForYou,
}: {
  colors: ThemeColors;
  t: TFunc;
  kind: 'noOffers' | 'expired' | 'noMatch';
  onResetFilter: () => void;
  onGoForYou: () => void;
}) {
  const config: Record<
    typeof kind,
    {
      icon: IconName;
      tone: 'primary' | 'warning';
      titleKey: string;
      bodyKey: string;
      ctaKey?: string;
      ctaIcon?: IconName;
      onCta?: () => void;
    }
  > = {
    noOffers: {
      icon: 'tag',
      tone: 'primary',
      titleKey: 'cheffity.offers.empty.noOffersTitle',
      bodyKey: 'cheffity.offers.empty.noOffersBody',
      ctaKey: 'cheffity.offers.empty.noOffersCta',
      ctaIcon: 'sparkle',
      onCta: onGoForYou,
    },
    expired: {
      icon: 'clock',
      tone: 'warning',
      titleKey: 'cheffity.offers.empty.expiredTitle',
      bodyKey: 'cheffity.offers.empty.expiredBody',
      ctaKey: 'cheffity.offers.empty.noOffersCta',
      ctaIcon: 'sparkle',
      onCta: onGoForYou,
    },
    noMatch: {
      icon: 'search',
      tone: 'primary',
      titleKey: 'cheffity.offers.empty.noMatchTitle',
      bodyKey: 'cheffity.offers.empty.noMatchBody',
      ctaKey: 'cheffity.offers.empty.noMatchCta',
      ctaIcon: 'refresh',
      onCta: onResetFilter,
    },
  };
  const v = config[kind];
  const ring = v.tone === 'warning' ? colors.warningLight : colors.primaryLight;
  const fg = v.tone === 'warning' ? colors.warning : colors.primary;

  return (
    <View style={emptyStyles.wrap}>
      <View style={[emptyStyles.iconCircle, { backgroundColor: ring }]}>
        <Icon name={v.icon} size={28} color={fg} />
      </View>
      <Text style={[emptyStyles.title, { color: colors.text }]}>{t(v.titleKey)}</Text>
      <Text style={[emptyStyles.body, { color: colors.textSecondary }]}>{t(v.bodyKey)}</Text>
      {v.ctaKey && v.onCta ? (
        <Pressable style={[emptyStyles.cta, { backgroundColor: colors.primary }]} onPress={v.onCta}>
          {v.ctaIcon ? <Icon name={v.ctaIcon} size={16} color="#FFFFFF" /> : null}
          <Text style={emptyStyles.ctaText}>{t(v.ctaKey)}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const emptyStyles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    paddingTop: spacing.xl * 2,
    paddingHorizontal: spacing.xl,
    gap: spacing.sm,
  },
  iconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    fontFamily: fontFamilies.displaySemibold,
    fontSize: 19,
    letterSpacing: -0.3,
    textAlign: 'center',
    marginTop: 4,
  },
  body: {
    fontSize: 13.5,
    fontFamily: fontFamilies.medium,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 280,
  },
  cta: {
    marginTop: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingVertical: 12,
    paddingHorizontal: 22,
    borderRadius: 12,
  },
  ctaText: { color: '#FFFFFF', fontSize: 14, fontFamily: fontFamilies.bold },
});
