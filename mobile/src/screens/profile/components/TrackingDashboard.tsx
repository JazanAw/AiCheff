import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { fontFamilies, radius, spacing, typography } from '../../../theme';
import type { ThemeColors } from '../../../theme';
import { Icon } from '../../../components/common/Icon';
import { usePreferences } from '../../../store/PreferencesContext';
import type { MealCategory, MealLogEntry, NutritionTargets, Recipe } from '../../../types';
import {
  addMealEntry,
  addWater,
  deleteMealEntry,
  getWaterMl,
  listMealEntries,
  logRecipeAsMeal,
  sumMealEntries,
} from '../../../services/dietTrackingApi';
import { fetchRecipes } from '../../../services/recipesApi';
import { progressFraction, remainingProtein } from '../../../utils/nutritionTargets';
import { NutritionRing } from './NutritionRing';
import { ManualMealSheet, type ManualMealDraft } from './ManualMealSheet';
import { HighProteinSheet } from './HighProteinSheet';

interface Props {
  targets: NutritionTargets;
  colors: ThemeColors;
  t: (k: string, opts?: Record<string, unknown>) => string;
  onOpenSettings: () => void;
}

/** Local YYYY-MM-DD for "today" (calendar day the user sees). */
function todayLocalIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatLitres(ml: number): string {
  return (ml / 1000).toFixed(1).replace('.', ',');
}

export function TrackingDashboard({ targets, colors, t, onOpenSettings }: Props) {
  const { preferences } = usePreferences();
  const date = todayLocalIso();

  const [meals, setMeals] = useState<MealLogEntry[]>([]);
  const [waterMl, setWaterMl] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [manualOpen, setManualOpen] = useState(false);
  const [manualSaving, setManualSaving] = useState(false);

  const [proteinOpen, setProteinOpen] = useState(false);
  const [proteinLoading, setProteinLoading] = useState(false);
  const [highProteinRecipes, setHighProteinRecipes] = useState<Recipe[]>([]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [mealRows, water] = await Promise.all([listMealEntries(date), getWaterMl(date)]);
      setMeals(mealRows);
      setWaterMl(water);
    } catch (e) {
      setError(t('diet.loadError'));
      console.warn('[TrackingDashboard] load failed:', (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [date, t]);

  // Reload whenever the screen regains focus (e.g. after logging from planner).
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const totals = sumMealEntries(meals);
  const proteinPct = progressFraction(totals.protein, targets.protein);
  const missingProtein = remainingProtein(totals.protein, targets.protein);
  const caloriePct = progressFraction(totals.calories, targets.calories);
  const waterPct = progressFraction(waterMl, targets.waterMl);

  const handleAddWater = (deltaMl: number) => {
    // Optimistic; revert on failure.
    const previous = waterMl;
    setWaterMl((w) => Math.max(0, w + deltaMl));
    addWater(date, deltaMl)
      .then(setWaterMl)
      .catch((e) => {
        setWaterMl(previous);
        Alert.alert(t('common.error'), (e as Error).message);
      });
  };

  const handleManualSubmit = async (draft: ManualMealDraft) => {
    setManualSaving(true);
    try {
      const saved = await addMealEntry({
        date,
        category: draft.category,
        name: draft.name,
        calories: draft.calories,
        protein: draft.protein,
        carbs: draft.carbs,
        fat: draft.fat,
        satiety: draft.satiety,
        nutritionEstimated: true,
      });
      setMeals((prev) => [...prev, saved]);
      setManualOpen(false);
    } catch (e) {
      Alert.alert(t('common.error'), (e as Error).message);
    } finally {
      setManualSaving(false);
    }
  };

  const handleDeleteMeal = (id: string) => {
    const previous = meals;
    setMeals((prev) => prev.filter((m) => m.id !== id));
    deleteMealEntry(id).catch((e) => {
      setMeals(previous);
      Alert.alert(t('common.error'), (e as Error).message);
    });
  };

  const handleOpenProteinSuggestions = async () => {
    setProteinOpen(true);
    if (highProteinRecipes.length > 0) return;
    setProteinLoading(true);
    try {
      const all = await fetchRecipes({ limit: 80, preferences });
      const ranked = all
        .filter((r) => (r.nutritionPerServing?.protein ?? 0) > 0)
        .sort(
          (a, b) =>
            (b.nutritionPerServing?.protein ?? 0) - (a.nutritionPerServing?.protein ?? 0),
        )
        .slice(0, 10);
      setHighProteinRecipes(ranked);
    } catch (e) {
      console.warn('[TrackingDashboard] high-protein fetch failed:', (e as Error).message);
    } finally {
      setProteinLoading(false);
    }
  };

  const handleLogSuggestedRecipe = async (recipe: Recipe) => {
    try {
      const saved = await logRecipeAsMeal({
        date,
        category: 'snack',
        recipeId: recipe.id,
        recipeName: recipe.name,
        portions: 1,
        caloriesPerServing: recipe.nutritionPerServing?.calories,
        proteinPerServing: recipe.nutritionPerServing?.protein,
        carbsPerServing: recipe.nutritionPerServing?.carbs,
        fatPerServing: recipe.nutritionPerServing?.fat,
      });
      setMeals((prev) => [...prev, saved]);
      setProteinOpen(false);
    } catch (e) {
      Alert.alert(t('common.error'), (e as Error).message);
    }
  };

  if (loading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.primary} />
        <Text style={[typography.bodySmall, { color: colors.textSecondary, marginTop: spacing.sm }]}>
          {t('diet.loading')}
        </Text>
      </View>
    );
  }

  const categoryLabel = (c: MealCategory) => t(`diet.category.${c}`);

  return (
    <View>
      {error ? (
        <Text style={[typography.bodySmall, { color: colors.error, marginBottom: spacing.sm }]}>
          {error}
        </Text>
      ) : null}

      {/* Protein ring + calorie bar */}
      <View style={[styles.card, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}>
        <View style={styles.ringRow}>
          <NutritionRing
            progress={proteinPct}
            size={150}
            strokeWidth={14}
            color={colors.primary}
            trackColor={colors.primaryLight}
            centerValue={`${Math.round(totals.protein)}`}
            centerLabel={t('diet.proteinShort')}
            subLabel={t('diet.ofTarget', { target: Math.round(targets.protein) })}
            colors={colors}
          />
          <View style={styles.ringSide}>
            <Text style={[styles.ringPct, { color: colors.primary }]}>
              {Math.round(proteinPct * 100)}%
            </Text>
            <Text style={[styles.ringSideLabel, { color: colors.textSecondary }]}>
              {t('diet.proteinReached')}
            </Text>
            {missingProtein > 0 ? (
              <Text style={[styles.ringSideHint, { color: colors.textTertiary }]}>
                {t('diet.cheffity.missingProtein', { grams: missingProtein })}
              </Text>
            ) : (
              <Text style={[styles.ringSideHint, { color: colors.success }]}>
                {t('diet.proteinDone')}
              </Text>
            )}
          </View>
        </View>

        {/* Calorie bar */}
        <View style={styles.calorieBlock}>
          <View style={styles.calorieHeader}>
            <View style={styles.calorieLabelRow}>
              <Icon name="flame" size={15} color={colors.accent} />
              <Text style={[styles.calorieLabel, { color: colors.text }]}>
                {t('diet.calories')}
              </Text>
            </View>
            <Text style={[styles.calorieValue, { color: colors.textSecondary }]}>
              {Math.round(totals.calories)} / {Math.round(targets.calories)} kcal
            </Text>
          </View>
          <View style={[styles.barTrack, { backgroundColor: colors.borderLight }]}>
            <View
              style={[
                styles.barFill,
                { width: `${caloriePct * 100}%`, backgroundColor: colors.accent },
              ]}
            />
          </View>
        </View>

        {targets.isEstimateOnly ? (
          <Text style={[styles.estimateNote, { color: colors.textTertiary }]}>
            {t('diet.estimateOnly')}
          </Text>
        ) : null}
        {targets.aggressiveWarning ? (
          <View style={[styles.warnRow, { backgroundColor: colors.warningLight }]}>
            <Icon name="info" size={14} color={colors.warning} />
            <Text style={[styles.warnText, { color: colors.warning }]}>
              {t('diet.aggressiveWarning')}
            </Text>
          </View>
        ) : null}
      </View>

      {/* Mini macros */}
      <View style={styles.macroRow}>
        {([
          ['protein', totals.protein, colors.primary],
          ['carbs', totals.carbs, colors.carbs],
          ['fat', totals.fat, colors.fat],
        ] as const).map(([key, value, color]) => (
          <View
            key={key}
            style={[styles.macroCard, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}
          >
            <View style={[styles.macroDot, { backgroundColor: color }]} />
            <Text style={[styles.macroValue, { color: colors.text }]}>{Math.round(value)} g</Text>
            <Text style={[styles.macroLabel, { color: colors.textSecondary }]}>
              {t(`diet.macros.${key}`)}
            </Text>
          </View>
        ))}
      </View>

      {/* Water */}
      <View style={[styles.card, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}>
        <View style={styles.waterHeader}>
          <View style={styles.calorieLabelRow}>
            <Icon name="droplet" size={16} color={colors.water} />
            <Text style={[styles.calorieLabel, { color: colors.text }]}>{t('diet.water')}</Text>
          </View>
          <Text style={[styles.calorieValue, { color: colors.textSecondary }]}>
            {formatLitres(waterMl)} / {formatLitres(targets.waterMl)} L
          </Text>
        </View>
        <View style={[styles.barTrack, { backgroundColor: colors.borderLight }]}>
          <View
            style={[styles.barFill, { width: `${waterPct * 100}%`, backgroundColor: colors.water }]}
          />
        </View>
        <View style={styles.waterButtons}>
          <Pressable
            style={[styles.waterButton, { backgroundColor: colors.waterLight }]}
            onPress={() => handleAddWater(250)}
          >
            <Icon name="plus" size={14} color={colors.water} />
            <Text style={[styles.waterButtonText, { color: colors.water }]}>250 ml</Text>
          </Pressable>
          <Pressable
            style={[styles.waterButton, { backgroundColor: colors.waterLight }]}
            onPress={() => handleAddWater(500)}
          >
            <Icon name="plus" size={14} color={colors.water} />
            <Text style={[styles.waterButtonText, { color: colors.water }]}>500 ml</Text>
          </Pressable>
          {waterMl > 0 ? (
            <Pressable
              style={[styles.waterButton, { backgroundColor: colors.surface }]}
              onPress={() => handleAddWater(-250)}
            >
              <Icon name="minus" size={14} color={colors.textSecondary} />
              <Text style={[styles.waterButtonText, { color: colors.textSecondary }]}>250 ml</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* Cheffity connection: missing protein → high-protein recipes */}
      {missingProtein > 0 ? (
        <Pressable
          style={[styles.cheffityCard, { backgroundColor: colors.primaryLight, borderColor: colors.primary }]}
          onPress={handleOpenProteinSuggestions}
          accessibilityRole="button"
        >
          <View style={[styles.cheffityIconCircle, { backgroundColor: colors.surfaceElevated }]}>
            <Icon name="cheffity-hat" size={20} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.cheffityTitle, { color: colors.primary }]}>
              {t('diet.cheffity.missingProtein', { grams: missingProtein })}
            </Text>
            <Text style={[styles.cheffitySub, { color: colors.textSecondary }]}>
              {t('diet.cheffity.cta')}
            </Text>
          </View>
          <Icon name="chevron-right" size={18} color={colors.primary} />
        </Pressable>
      ) : null}

      {/* Today's meals */}
      <View style={styles.listHeader}>
        <Text style={[typography.label, { color: colors.textSecondary }]}>{t('diet.today')}</Text>
        <Pressable
          style={[styles.addButton, { backgroundColor: colors.primary }]}
          onPress={() => setManualOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={t('diet.manual.add')}
        >
          <Icon name="plus" size={15} color="#FFFFFF" />
          <Text style={styles.addButtonText}>{t('diet.manual.add')}</Text>
        </Pressable>
      </View>

      {meals.length === 0 ? (
        <Text style={[styles.empty, { color: colors.textTertiary }]}>{t('diet.noMeals')}</Text>
      ) : (
        meals.map((meal) => (
          <View
            key={meal.id}
            style={[styles.mealRow, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}
          >
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[styles.mealName, { color: colors.text }]} numberOfLines={1}>
                {meal.name}
              </Text>
              <Text style={[styles.mealMeta, { color: colors.textSecondary }]}>
                {categoryLabel(meal.category)}
                {meal.calories != null ? `  ·  ${Math.round(meal.calories)} kcal` : ''}
                {meal.protein != null ? `  ·  ${Math.round(meal.protein)} g ${t('diet.proteinShort')}` : ''}
                {meal.satiety != null ? `  ·  ${t('diet.manual.satiety')} ${meal.satiety}/5` : ''}
              </Text>
            </View>
            <Pressable onPress={() => handleDeleteMeal(meal.id)} hitSlop={8} style={styles.mealDelete}>
              <Icon name="trash" size={16} color={colors.error} />
            </Pressable>
          </View>
        ))
      )}

      <Text style={[styles.disclaimer, { color: colors.textTertiary }]}>
        {t('diet.nutritionDisclaimer')}
      </Text>

      <Pressable style={styles.settingsLink} onPress={onOpenSettings} accessibilityRole="button">
        <Icon name="sliders" size={15} color={colors.textSecondary} />
        <Text style={[styles.settingsLinkText, { color: colors.textSecondary }]}>
          {t('diet.openSettings')}
        </Text>
      </Pressable>

      <ManualMealSheet
        visible={manualOpen}
        saving={manualSaving}
        colors={colors}
        t={t}
        onCancel={() => setManualOpen(false)}
        onSubmit={handleManualSubmit}
      />

      <HighProteinSheet
        visible={proteinOpen}
        loading={proteinLoading}
        recipes={highProteinRecipes}
        missingProtein={missingProtein}
        colors={colors}
        t={t}
        onClose={() => setProteinOpen(false)}
        onLog={handleLogSuggestedRecipe}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { paddingVertical: spacing.xxl, alignItems: 'center' },
  card: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 18,
    marginBottom: spacing.md,
  },
  ringRow: { flexDirection: 'row', alignItems: 'center', gap: 18 },
  ringSide: { flex: 1, minWidth: 0 },
  ringPct: { fontFamily: fontFamilies.displayBold, fontSize: 30, letterSpacing: -0.5 },
  ringSideLabel: {
    fontFamily: fontFamilies.semibold,
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    marginTop: 2,
  },
  ringSideHint: { fontFamily: fontFamilies.regular, fontSize: 12.5, marginTop: spacing.sm },
  calorieBlock: { marginTop: spacing.lg },
  calorieHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  calorieLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  calorieLabel: { fontFamily: fontFamilies.semibold, fontSize: 14 },
  calorieValue: { fontFamily: fontFamilies.regular, fontSize: 13 },
  barTrack: { height: 10, borderRadius: 5, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 5 },
  estimateNote: { fontFamily: fontFamilies.regular, fontSize: 11.5, marginTop: spacing.sm },
  warnRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.md,
  },
  warnText: { fontFamily: fontFamilies.semibold, fontSize: 12, flex: 1 },
  macroRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  macroCard: {
    flex: 1,
    borderRadius: 14,
    borderWidth: 1,
    paddingVertical: 14,
    paddingHorizontal: 8,
    alignItems: 'center',
  },
  macroDot: { width: 8, height: 8, borderRadius: 4, marginBottom: 7 },
  macroValue: { fontFamily: fontFamilies.displaySemibold, fontSize: 17 },
  macroLabel: {
    fontFamily: fontFamilies.regular,
    fontSize: 10.5,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    marginTop: 3,
    textAlign: 'center',
  },
  waterHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  waterButtons: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  waterButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radius.md,
  },
  waterButtonText: { fontFamily: fontFamilies.semibold, fontSize: 13 },
  cheffityCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: 14,
    borderRadius: 18,
    borderWidth: 1,
    marginBottom: spacing.md,
  },
  cheffityIconCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cheffityTitle: { fontFamily: fontFamilies.bold, fontSize: 14 },
  cheffitySub: { fontFamily: fontFamilies.regular, fontSize: 12, marginTop: 1 },
  listHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.md,
  },
  addButtonText: { color: '#FFFFFF', fontFamily: fontFamilies.semibold, fontSize: 13 },
  empty: {
    fontFamily: fontFamilies.regular,
    fontSize: 13,
    paddingVertical: spacing.lg,
    textAlign: 'center',
  },
  mealRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: spacing.sm,
  },
  mealName: { fontFamily: fontFamilies.semibold, fontSize: 14.5 },
  mealMeta: { fontFamily: fontFamilies.regular, fontSize: 12, marginTop: 2 },
  mealDelete: { padding: 4 },
  disclaimer: {
    fontFamily: fontFamilies.regular,
    fontSize: 11,
    lineHeight: 15,
    marginTop: spacing.lg,
  },
  settingsLink: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: spacing.md,
    paddingVertical: spacing.sm,
  },
  settingsLinkText: { fontFamily: fontFamilies.semibold, fontSize: 13 },
});
