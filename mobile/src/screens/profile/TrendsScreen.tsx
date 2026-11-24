import React, { useEffect, useState } from 'react';
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useThemeColors, typography, spacing, radius } from '../../theme';
import type { ThemeColors } from '../../theme';
import { useSubscription } from '../../store/SubscriptionContext';
import { LockedFeature } from '../../components/common/LockedFeature';
import {
  fetchProductTrends,
  fetchRecipeTrends,
  type ProductTrendRow,
  type RecipeTrendRow,
} from '../../services/trendsApi';

interface Props {
  onBack: () => void;
}

export function TrendsScreen({ onBack }: Props) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { hasFeature, requiredTier } = useSubscription();

  const [recipeTrends, setRecipeTrends] = useState<RecipeTrendRow[]>([]);
  const [productTrends, setProductTrends] = useState<ProductTrendRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasFeature('cheffity')) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([fetchRecipeTrends(20), fetchProductTrends(30)])
      .then(([recipes, products]) => {
        if (cancelled) return;
        setRecipeTrends(recipes);
        setProductTrends(products);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [hasFeature]);

  if (!hasFeature('cheffity')) {
    return (
      <LockedFeature requiredTier={requiredTier('cheffity')} onUpgrade={onBack}>
        <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
          <Header onBack={onBack} title={t('trends.title')} colors={colors} t={t} />
        </SafeAreaView>
      </LockedFeature>
    );
  }

  const isEmpty = !loading && recipeTrends.length === 0 && productTrends.length === 0;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
      <Header onBack={onBack} title={t('trends.title')} colors={colors} t={t} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[typography.body, { color: colors.textSecondary, marginBottom: spacing.lg }]}>
          {t('trends.subtitle')}
        </Text>

        {error && (
          <View style={[styles.errorBox, { backgroundColor: colors.errorLight, borderColor: colors.error }]}>
            <Text style={[typography.bodySmall, { color: colors.error }]}>{error}</Text>
          </View>
        )}

        {loading && (
          <Text style={[typography.body, { color: colors.textSecondary, textAlign: 'center', marginTop: spacing.xl }]}>
            {t('common.loading')}
          </Text>
        )}

        {isEmpty && (
          <View style={[styles.empty, { borderColor: colors.borderLight }]}>
            <Text style={[typography.body, { color: colors.textSecondary, textAlign: 'center' }]}>
              {t('trends.empty')}
            </Text>
          </View>
        )}

        {recipeTrends.length > 0 && (
          <View style={styles.section}>
            <Text style={[typography.label, { color: colors.textSecondary, marginBottom: spacing.sm }]}>
              {t('trends.recipesSection')}
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              {recipeTrends.map((row) => (
                <RecipeTrendCard key={row.recipeId} row={row} colors={colors} t={t} />
              ))}
            </ScrollView>
          </View>
        )}

        {productTrends.length > 0 && (
          <View style={styles.section}>
            <Text style={[typography.label, { color: colors.textSecondary, marginBottom: spacing.sm }]}>
              {t('trends.productsSection')}
            </Text>
            <View>
              {productTrends.map((row) => (
                <ProductTrendRow key={row.nameKey} row={row} colors={colors} t={t} />
              ))}
            </View>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Header({
  onBack,
  title,
  colors,
  t,
}: {
  onBack: () => void;
  title: string;
  colors: ThemeColors;
  t: (k: string) => string;
}) {
  return (
    <View style={styles.header}>
      <Pressable onPress={onBack}>
        <Text style={[typography.button, { color: colors.primary }]}>{t('common.back')}</Text>
      </Pressable>
      <Text style={[typography.h3, { color: colors.text }]}>{title}</Text>
      <View style={{ width: 50 }} />
    </View>
  );
}

function RecipeTrendCard({
  row,
  colors,
  t,
}: {
  row: RecipeTrendRow;
  colors: ThemeColors;
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  return (
    <View
      style={[
        styles.recipeCard,
        { backgroundColor: colors.surfaceElevated, borderColor: colors.borderLight },
      ]}
    >
      {row.imageUrl ? (
        <Image source={{ uri: row.imageUrl }} style={styles.recipeImage} />
      ) : (
        <View style={[styles.recipeImage, { backgroundColor: colors.surface, justifyContent: 'center', alignItems: 'center' }]}>
          <Text style={{ fontSize: 28 }}>🍽️</Text>
        </View>
      )}
      <View style={{ padding: spacing.md, gap: 4 }}>
        <Text style={[typography.body, { color: colors.text, fontWeight: '700' }]} numberOfLines={2}>
          {row.name}
        </Text>
        <View style={styles.recipeStats}>
          <View style={[styles.statPill, { backgroundColor: colors.primaryLight }]}>
            <Text style={[styles.statText, { color: colors.primary }]}>
              {t('trends.plannedCount', { count: row.plannedCount30d + row.swipePlanCount30d })}
            </Text>
          </View>
          {row.cookedCount30d > 0 && (
            <View style={[styles.statPill, { backgroundColor: colors.accentLight }]}>
              <Text style={[styles.statText, { color: colors.accent }]}>
                {t('trends.cookedCount', { count: row.cookedCount30d })}
              </Text>
            </View>
          )}
        </View>
        {row.rating != null && (
          <View style={styles.ratingRow}>
            <Text style={{ color: '#FFC857', fontSize: 13 }}>★</Text>
            <Text style={[typography.caption, { color: colors.textSecondary }]}>
              {' '}{row.rating.toFixed(1)} ({row.ratingCount})
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

function ProductTrendRow({
  row,
  colors,
  t,
}: {
  row: ProductTrendRow;
  colors: ThemeColors;
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  const buyRate = row.addedCount > 0 ? Math.round((row.purchasedCount / row.addedCount) * 100) : 0;
  return (
    <View style={[styles.productRow, { borderBottomColor: colors.borderLight }]}>
      <View style={{ flex: 1 }}>
        <Text style={[typography.body, { color: colors.text, fontWeight: '600' }]} numberOfLines={1}>
          {row.sampleName}
        </Text>
        <Text style={[typography.caption, { color: colors.textTertiary }]}>
          {t('trends.addedCount', { count: row.addedCount })}
          {' · '}
          {t('trends.purchasedCount', { count: row.purchasedCount })}
          {buyRate > 0 && ` · ${buyRate}%`}
        </Text>
      </View>
      <View style={[styles.countBadge, { backgroundColor: colors.primaryLight }]}>
        <Text style={[styles.countBadgeText, { color: colors.primary }]}>
          {row.addedCount}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  content: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  errorBox: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    marginBottom: spacing.md,
  },
  empty: {
    paddingVertical: spacing.xxl,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderStyle: 'dashed',
    alignItems: 'center',
  },
  section: { marginBottom: spacing.xl },
  recipeCard: {
    width: 200,
    borderRadius: radius.lg,
    borderWidth: 1,
    marginRight: spacing.md,
    overflow: 'hidden',
  },
  recipeImage: { width: 200, height: 110, resizeMode: 'cover' },
  recipeStats: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  statPill: {
    paddingVertical: 2,
    paddingHorizontal: 8,
    borderRadius: 999,
  },
  statText: { fontSize: 11, fontWeight: '600' },
  ratingRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  productRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    gap: spacing.sm,
  },
  countBadge: {
    minWidth: 36,
    height: 28,
    borderRadius: 999,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countBadgeText: { fontSize: 13, fontWeight: '700' },
});
