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
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { fontFamilies, spacing, useThemeColors } from '../../theme';
import type { ThemeColors } from '../../theme';
import { Icon } from '../../components/common/Icon';
import type { IconName } from '../../components/common/Icon';
import { RecipeIllustration } from '../../components/common/RecipeIllustration';
import { CoverageBar, CoverageChip } from '../../components/common/CoverageVisuals';
import type { CoverageTone, ChipGlyph } from '../../components/common/CoverageVisuals';
import { getCuisineLabel, normalizeCuisine } from '../../utils/cuisine';
import {
  filterAlmostReady,
  filterCheapRecipes,
  filterReadyFromStock,
  rankRecipesForCooking,
} from '../../utils/pantryMatch';
import type { RecipeCoverage } from '../../utils/pantryMatch';
import type { PantryItem, Recipe } from '../../types';

export type PantryViewMode = 'pantry' | 'almost' | 'cheap';

type Nav = NavigationProp<Record<string, object | undefined>>;

interface Props {
  recipes: Recipe[];
  pantryItems: PantryItem[];
  mode: PantryViewMode;
  /** Vertical offset to clear the floating header / tab bar above. */
  contentTopInset: number;
  bottomInset: number;
  onOpenRecipe: (recipe: Recipe) => void;
  /** Open the "Zum Wochenplan" sheet for a recipe (calendar button). */
  onPlanRecipe: (recipe: Recipe) => void;
}

export function PantryRecipesView({
  recipes,
  pantryItems,
  mode,
  contentTopInset,
  bottomInset,
  onOpenRecipe,
  onPlanRecipe,
}: Props) {
  const { t } = useTranslation();
  const colors = useThemeColors();

  // Score-rank once, then narrow to the active tab. The weighted score
  // (coverage-dominant, cook-time tie-break) decides ordering inside every tab.
  const base = useMemo(
    () => rankRecipesForCooking(recipes, pantryItems),
    [recipes, pantryItems],
  );
  const ranked = useMemo(() => {
    if (mode === 'almost') return filterAlmostReady(base);
    if (mode === 'cheap') return filterCheapRecipes(base);
    return filterReadyFromStock(base);
  }, [base, mode]);

  const pantryCount = pantryItems.filter((i) => !i.consumedAt).length;

  const headerComponent = (
    <PantryRecipesHeader
      colors={colors}
      pantryItemCount={pantryCount}
      recipeCount={ranked.length}
      t={t}
    />
  );

  const renderItem: ListRenderItem<(typeof ranked)[number]> = ({ item }) => (
    <RecipeCoverageCard
      recipe={item.recipe}
      coverage={item.coverage}
      mode={mode}
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
      ListHeaderComponent={headerComponent}
      ListEmptyComponent={
        <EmptyState
          colors={colors}
          mode={mode}
          pantryEmpty={pantryCount === 0}
          t={t}
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

// ─── Header — "Kochen mit Lager" title + pantry-context subline ─────────────

function PantryRecipesHeader({
  colors,
  pantryItemCount,
  recipeCount,
  t,
}: {
  colors: ThemeColors;
  pantryItemCount: number;
  recipeCount: number;
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  return (
    <View style={headerStyles.wrap}>
      <Text style={[headerStyles.title, { color: colors.text }]}>
        {t('cheffity.pantryView.screenTitle')}
      </Text>
      <Text style={[headerStyles.sub, { color: colors.textSecondary }]}>
        {t('cheffity.pantryView.headerSubline', {
          pantry: pantryItemCount,
          recipes: recipeCount,
        })}
      </Text>
    </View>
  );
}

const headerStyles = StyleSheet.create({
  wrap: { paddingTop: spacing.xs, paddingBottom: spacing.md, paddingHorizontal: 4 },
  title: {
    fontFamily: fontFamilies.displaySemibold,
    fontSize: 26,
    lineHeight: 30,
    letterSpacing: -0.5,
  },
  sub: {
    marginTop: 4,
    fontSize: 13.5,
    fontFamily: fontFamilies.medium,
  },
});

// ─── Recipe coverage card ───────────────────────────────────────────────────

interface HeaderBadge {
  tone: CoverageTone;
  glyph: ChipGlyph;
  label: string;
}

function recipeHeaderBadge(
  coverage: RecipeCoverage,
  cheapMode: boolean,
  t: (k: string, opts?: Record<string, unknown>) => string,
): HeaderBadge {
  const fullMatch = coverage.missingCount === 0 && coverage.unclearCount === 0;
  if (fullMatch) {
    return { tone: 'success', glyph: 'check', label: t('cheffity.pantryView.badge.fullMatch') };
  }
  if (cheapMode && coverage.missingOnDealCount >= 2) {
    return {
      tone: 'deal',
      glyph: 'spark',
      label: t('cheffity.pantryView.statOnDeal', { count: coverage.missingOnDealCount }),
    };
  }
  if (coverage.missingCount === 0) {
    // Covered, just some unclear amounts — still positive.
    return { tone: 'success', glyph: 'check', label: t('cheffity.pantryView.badge.inStock') };
  }
  if (coverage.missingCount === 1) {
    return { tone: 'warning', glyph: 'dot', label: t('cheffity.pantryView.badge.oneMissing') };
  }
  if (coverage.missingCount <= 2) {
    return {
      tone: 'warning',
      glyph: 'dot',
      label: t('cheffity.pantryView.badge.moreMissing', { count: coverage.missingCount }),
    };
  }
  return {
    tone: 'miss',
    glyph: 'none',
    label: t('cheffity.pantryView.badge.manyMissingShort', { count: coverage.missingCount }),
  };
}

function RecipeCoverageCard({
  recipe,
  coverage,
  mode,
  colors,
  t,
  onOpen,
  onPlan,
}: {
  recipe: Recipe;
  coverage: RecipeCoverage;
  mode: PantryViewMode;
  colors: ThemeColors;
  t: (k: string, opts?: Record<string, unknown>) => string;
  onOpen: () => void;
  onPlan: () => void;
}) {
  const cheapMode = mode === 'cheap';
  const fullMatch = coverage.missingCount === 0 && coverage.unclearCount === 0;
  const badge = recipeHeaderBadge(coverage, cheapMode, t);

  return (
    <Pressable
      onPress={onOpen}
      style={[
        cardStyles.card,
        {
          backgroundColor: fullMatch ? colors.successLight : colors.surfaceElevated,
          borderColor: fullMatch ? colors.success + '33' : colors.borderLight,
        },
      ]}
    >
      <View style={cardStyles.topRow}>
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
          <Text style={[cardStyles.title, { color: colors.text }]} numberOfLines={1}>
            {recipe.name}
          </Text>
          <View style={cardStyles.metaRow}>
            <Icon name="clock" size={13} color={colors.textSecondary} />
            <Text style={[cardStyles.metaText, { color: colors.textSecondary }]}>
              {t('cheffity.cookTime', { minutes: recipe.cookTimeMinutes })}
            </Text>
            <Text style={[cardStyles.metaDivider, { color: colors.textTertiary }]}>·</Text>
            <Text style={[cardStyles.metaText, { color: colors.textSecondary }]}>
              {t('cheffity.pantryView.statInPantry', {
                have: coverage.availableCount,
                total: coverage.totalCount,
              })}
            </Text>
            {recipe.cuisine ? (
              <>
                <Text style={[cardStyles.metaDivider, { color: colors.textTertiary }]}>·</Text>
                <Text
                  style={[cardStyles.metaText, { color: colors.textSecondary }]}
                  numberOfLines={1}
                >
                  {getCuisineLabel(normalizeCuisine(recipe.cuisine), t)}
                </Text>
              </>
            ) : null}
          </View>
          <View style={cardStyles.barWrap}>
            <CoverageBar
              available={coverage.availableCount}
              unclear={coverage.unclearCount}
              total={coverage.totalCount}
              colors={colors}
            />
          </View>
        </View>
        <Pressable
          onPress={onPlan}
          hitSlop={8}
          accessibilityLabel={t('cheffity.planSheet.planAction')}
          style={[
            cardStyles.planButton,
            { backgroundColor: colors.accentLight, borderColor: colors.accent + '55' },
          ]}
        >
          <Icon name="plan" size={18} color={colors.accent} />
        </Pressable>
      </View>

      <View style={cardStyles.chipRow}>
        <CoverageChip tone={badge.tone} glyph={badge.glyph} label={badge.label} colors={colors} />
        {coverage.unclearCount > 0 && (
          <CoverageChip
            tone="warning"
            glyph="dot"
            label={t('cheffity.pantryView.statUnclear', { count: coverage.unclearCount })}
            colors={colors}
          />
        )}
        {coverage.missingOnDealCount > 0 && !cheapMode && (
          <CoverageChip
            tone="deal"
            glyph="spark"
            label={t('cheffity.pantryView.statOnDeal', { count: coverage.missingOnDealCount })}
            colors={colors}
          />
        )}
        {cheapMode && coverage.estimatedMissingCost != null && (
          <Text style={[cardStyles.trailingNote, { color: colors.textSecondary }]}>
            {t('cheffity.pantryView.missingCostShort', {
              amount: coverage.estimatedMissingCost.toFixed(2).replace('.', ','),
            })}
          </Text>
        )}
        {!cheapMode && fullMatch && (
          <Text style={[cardStyles.trailingNote, { color: colors.success, fontFamily: fontFamilies.bold }]}>
            {t('cheffity.pantryView.cookNow')}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

const cardStyles = StyleSheet.create({
  card: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 12,
    gap: 10,
  },
  topRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  planButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
  },
  thumb: {
    width: 84,
    height: 84,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#000',
    flexShrink: 0,
  },
  thumbImage: { width: '100%', height: '100%', resizeMode: 'cover' },
  thumbIllustration: {
    ...StyleSheet.absoluteFillObject,
    transform: [{ scale: 1.25 }],
  },
  titleBlock: { flex: 1, minWidth: 0, gap: 6 },
  title: {
    fontFamily: fontFamilies.displaySemibold,
    fontSize: 17,
    lineHeight: 21,
    letterSpacing: -0.2,
  },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  metaText: { fontSize: 12.5, fontFamily: fontFamilies.medium },
  metaDivider: { fontSize: 12.5 },
  barWrap: { marginTop: 2 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  trailingNote: {
    marginLeft: 'auto',
    fontSize: 11.5,
    fontFamily: fontFamilies.semibold,
  },
});

// ─── Empty state ───────────────────────────────────────────────────────────

function EmptyState({
  colors,
  mode,
  pantryEmpty,
  t,
}: {
  colors: ThemeColors;
  mode: PantryViewMode;
  pantryEmpty: boolean;
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  const navigation = useNavigation<Nav>();

  const kind = pantryEmpty ? 'noPantry' : mode;
  const config: Record<
    string,
    { icon: IconName; titleKey: string; bodyKey: string }
  > = {
    noPantry: {
      icon: 'pantry',
      titleKey: 'cheffity.pantryView.empty.pantryEmptyTitle',
      bodyKey: 'cheffity.pantryView.empty.pantryEmptyBody',
    },
    pantry: {
      icon: 'search',
      titleKey: 'cheffity.pantryView.empty.noMatchTitle',
      bodyKey: 'cheffity.pantryView.empty.noMatchBody',
    },
    almost: {
      icon: 'search',
      titleKey: 'cheffity.pantryView.empty.noAlmostTitle',
      bodyKey: 'cheffity.pantryView.empty.noAlmostBody',
    },
    cheap: {
      icon: 'tag',
      titleKey: 'cheffity.pantryView.empty.noCheapTitle',
      bodyKey: 'cheffity.pantryView.empty.noCheapBody',
    },
  };
  const v = config[kind] ?? config.pantry;
  const ctaKey = pantryEmpty
    ? 'cheffity.pantryView.empty.ctaScanPantry'
    : 'cheffity.pantryView.empty.ctaOpenPantry';

  return (
    <View style={emptyStyles.wrap}>
      <View style={[emptyStyles.iconCircle, { backgroundColor: colors.primaryLight }]}>
        <Icon name={v.icon} size={30} color={colors.primary} active />
      </View>
      <Text style={[emptyStyles.title, { color: colors.text }]}>{t(v.titleKey)}</Text>
      <Text style={[emptyStyles.body, { color: colors.textSecondary }]}>{t(v.bodyKey)}</Text>
      <Pressable
        style={[emptyStyles.cta, { backgroundColor: colors.primary }]}
        onPress={() => navigation.navigate('InventoryHub')}
      >
        <Text style={emptyStyles.ctaText}>{t(ctaKey)}</Text>
      </Pressable>
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
    width: 72,
    height: 72,
    borderRadius: 36,
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    fontFamily: fontFamilies.displaySemibold,
    fontSize: 20,
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
    paddingVertical: 12,
    paddingHorizontal: 22,
    borderRadius: 12,
  },
  ctaText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontFamily: fontFamilies.bold,
  },
});
