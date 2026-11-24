import React, { useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureDetector } from 'react-native-gesture-handler';
import Reanimated from 'react-native-reanimated';
import { useSwipeToDismiss } from '../../../components/common/useSwipeToDismiss';
import { fontFamilies, radius, spacing, typography } from '../../../theme';
import type { ThemeColors } from '../../../theme';
import { Icon } from '../../../components/common/Icon';
import type { MealType, PantryItem, Recipe } from '../../../types';
import {
  PLAN_SHEET_MEALS,
  countMissingIngredients,
  defaultPlanMeal,
} from '../../../utils/planning';
import { todayDayOfWeek } from '../../../services/plannerApi';

// 0 = Monday … 6 = Sunday — matches weekly_plan_entries.day_of_week and the
// planner's DAY_KEYS so day selection lines up across screens.
const DAY_KEYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

export interface PlanRecipeChoice {
  dayOfWeek: number;
  mealType: MealType;
  portions: number;
  addMissingToShopping: boolean;
}

interface Props {
  visible: boolean;
  recipe: Recipe | null;
  defaultPortions: number;
  pantryItems?: PantryItem[];
  colors: ThemeColors;
  t: (k: string, opts?: Record<string, unknown>) => string;
  onCancel: () => void;
  onConfirm: (choice: PlanRecipeChoice) => void;
  /** 'create' (default) for first-time planning, 'edit' when changing an
   *  existing weekly_plan_entry — switches the title/confirm labels. */
  mode?: 'create' | 'edit';
  /** Seed values (edit mode). When omitted, create-mode defaults apply
   *  (today / the recipe's meal type / default portions). */
  initialDayOfWeek?: number;
  initialMealType?: MealType;
  initialPortions?: number;
  /** Show the "add missing ingredients" toggle. Defaults to true in create
   *  mode and false in edit mode (re-adding on a plan change would duplicate). */
  showAddMissing?: boolean;
}

/**
 * Unified "Zum Wochenplan" bottom sheet used by the swipe flow, the recipe
 * details, the Lager/Fast/Günstig lists AND the weekly planner's "Plan
 * ändern". Purely collects the user's choice (day, meal, portions,
 * add-missing) and hands it back via onConfirm; persistence lives in the
 * caller (planRecipeToWeek / planner upsert) so every caller behaves the same.
 */
export function PlanRecipeSheet({
  visible,
  recipe,
  defaultPortions,
  pantryItems = [],
  colors,
  t,
  onCancel,
  onConfirm,
  mode = 'create',
  initialDayOfWeek,
  initialMealType,
  initialPortions,
  showAddMissing,
}: Props) {
  const insets = useSafeAreaInsets();
  const { gesture, sheetStyle, backdropStyle, scrollHandler, scrollRef } = useSwipeToDismiss({
    visible,
    onDismiss: onCancel,
    mode: 'standalone',
  });
  const isEdit = mode === 'edit';
  const addMissingVisible = showAddMissing ?? !isEdit;

  const [dayOfWeek, setDayOfWeek] = useState(() => todayDayOfWeek());
  const [mealType, setMealType] = useState<MealType>('lunch');
  const [portions, setPortions] = useState(defaultPortions);
  const [addMissing, setAddMissing] = useState(true);

  // Seed the choice each time the sheet opens. Edit mode pre-fills the
  // entry's current slot; create mode falls back to today / recipe meal type.
  useEffect(() => {
    if (visible && recipe) {
      setDayOfWeek(initialDayOfWeek ?? todayDayOfWeek());
      setMealType(initialMealType ?? defaultPlanMeal(recipe.mealType));
      setPortions(initialPortions ?? defaultPortions);
      setAddMissing(!isEdit);
    }
  }, [visible, recipe, defaultPortions, initialDayOfWeek, initialMealType, initialPortions, isEdit]);

  const missingCount = useMemo(
    () => (recipe ? countMissingIngredients(recipe.ingredients, pantryItems) : 0),
    [recipe, pantryItems],
  );

  const dec = () => setPortions((p) => Math.max(1, p - 1));
  const inc = () => setPortions((p) => Math.min(12, p + 1));

  const handleConfirm = () => {
    onConfirm({ dayOfWeek, mealType, portions, addMissingToShopping: addMissing });
  };

  const today = todayDayOfWeek();

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={visible ? 'auto' : 'none'}>
      <Reanimated.View style={[styles.backdrop, backdropStyle]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} />
      </Reanimated.View>

      <GestureDetector gesture={gesture}>
      <Reanimated.View
        style={[
          styles.sheet,
          {
            backgroundColor: colors.surfaceElevated,
            paddingBottom: insets.bottom + spacing.lg,
          },
          sheetStyle,
        ]}
      >
        <View style={[styles.handleBar, { backgroundColor: colors.border }]} />

        <Text style={[styles.heading, { color: colors.text }]} numberOfLines={2}>
          {isEdit ? t('cheffity.planSheet.editTitle') : t('cheffity.planSheet.title')}
        </Text>
        {recipe ? (
          <Text style={[styles.recipeName, { color: colors.textSecondary }]} numberOfLines={1}>
            {recipe.name}
          </Text>
        ) : null}

        <Reanimated.ScrollView
          ref={scrollRef}
          onScroll={scrollHandler}
          scrollEventThrottle={16}
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {/* Day picker */}
          <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>
            {t('cheffity.planSheet.dayLabel')}
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipRow}
          >
            {DAY_KEYS.map((key, index) => {
              const active = index === dayOfWeek;
              return (
                <Pressable
                  key={key}
                  onPress={() => setDayOfWeek(index)}
                  style={[
                    styles.dayChip,
                    {
                      backgroundColor: active ? colors.primary : colors.surface,
                      borderColor: active ? colors.primary : colors.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.dayChipText,
                      { color: active ? '#FFFFFF' : colors.text },
                    ]}
                  >
                    {t(`planner.daysShort.${key}`)}
                  </Text>
                  {index === today ? (
                    <Text
                      style={[
                        styles.todayDot,
                        { color: active ? '#FFFFFF' : colors.primary },
                      ]}
                    >
                      {t('cheffity.planSheet.today')}
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
          </ScrollView>

          {/* Meal picker */}
          <Text style={[styles.sectionLabel, { color: colors.textSecondary, marginTop: spacing.md }]}>
            {t('cheffity.planSheet.mealLabel')}
          </Text>
          <View style={styles.mealWrap}>
            {PLAN_SHEET_MEALS.map((meal) => {
              const active = meal === mealType;
              return (
                <Pressable
                  key={meal}
                  onPress={() => setMealType(meal)}
                  style={[
                    styles.mealChip,
                    {
                      backgroundColor: active ? colors.primary : colors.surface,
                      borderColor: active ? colors.primary : colors.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.mealChipText,
                      { color: active ? '#FFFFFF' : colors.text },
                    ]}
                  >
                    {t(`cheffity.mealTypes.${meal}`)}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {/* Portions */}
          <Text style={[styles.sectionLabel, { color: colors.textSecondary, marginTop: spacing.md }]}>
            {t('cheffity.planSheet.portionLabel')}
          </Text>
          <View style={styles.portionRow}>
            <Pressable
              onPress={dec}
              disabled={portions <= 1}
              style={[styles.portionButton, { borderColor: colors.border, backgroundColor: colors.surface }]}
            >
              <Text style={[styles.portionButtonText, { color: colors.text, opacity: portions <= 1 ? 0.3 : 1 }]}>−</Text>
            </Pressable>
            <Text style={[styles.portionNumber, { color: colors.primary }]}>{portions}</Text>
            <Pressable
              onPress={inc}
              disabled={portions >= 12}
              style={[styles.portionButton, { borderColor: colors.border, backgroundColor: colors.surface }]}
            >
              <Text style={[styles.portionButtonText, { color: colors.text, opacity: portions >= 12 ? 0.3 : 1 }]}>+</Text>
            </Pressable>
          </View>

          {/* Add-missing-to-shopping toggle (hidden in edit mode) */}
          {addMissingVisible && (
            <Pressable
              onPress={() => setAddMissing((v) => !v)}
              style={[
                styles.toggleRow,
                { backgroundColor: colors.surface, borderColor: colors.border },
              ]}
            >
              <View style={styles.toggleTextWrap}>
                <Text style={[styles.toggleTitle, { color: colors.text }]}>
                  {t('cheffity.planSheet.addMissingTitle')}
                </Text>
                <Text style={[styles.toggleSub, { color: colors.textSecondary }]} numberOfLines={2}>
                  {missingCount > 0
                    ? t('cheffity.planSheet.addMissingCount', { count: missingCount })
                    : t('cheffity.planSheet.addMissingNone')}
                </Text>
              </View>
              <View
                style={[
                  styles.checkbox,
                  {
                    backgroundColor: addMissing ? colors.primary : 'transparent',
                    borderColor: addMissing ? colors.primary : colors.border,
                  },
                ]}
              >
                {addMissing ? <Icon name="check" size={15} color="#FFFFFF" strokeWidth={3} /> : null}
              </View>
            </Pressable>
          )}
        </Reanimated.ScrollView>

        <View style={styles.actions}>
          <Pressable
            style={[styles.cancelButton, { backgroundColor: colors.surface, borderColor: colors.border }]}
            onPress={onCancel}
          >
            <Text style={[typography.button, { color: colors.text }]}>{t('common.cancel')}</Text>
          </Pressable>
          <Pressable
            style={[styles.confirmButton, { backgroundColor: colors.accent }]}
            onPress={handleConfirm}
          >
            <Icon name="plan" size={17} color="#FFFFFF" />
            <Text style={[typography.button, { color: '#FFFFFF' }]}>
              {isEdit ? t('cheffity.planSheet.editConfirm') : t('cheffity.planSheet.confirm')}
            </Text>
          </Pressable>
        </View>
      </Reanimated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '88%',
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
  },
  handleBar: {
    width: 40,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: spacing.sm,
  },
  heading: {
    ...typography.h3,
    textAlign: 'center',
    marginTop: spacing.xs,
  },
  recipeName: {
    ...typography.body,
    textAlign: 'center',
    marginTop: 2,
    marginBottom: spacing.sm,
  },
  scroll: { flexGrow: 0 },
  scrollContent: { paddingBottom: spacing.sm },
  sectionLabel: {
    fontSize: 13,
    fontFamily: fontFamilies.semibold,
    marginBottom: spacing.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  chipRow: { gap: 8, paddingVertical: 2, paddingRight: spacing.md },
  dayChip: {
    minWidth: 52,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
  },
  dayChipText: { fontSize: 14, fontFamily: fontFamilies.bold },
  todayDot: { fontSize: 9, fontFamily: fontFamilies.semibold, marginTop: 1 },
  mealWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  mealChip: {
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
  },
  mealChipText: { fontSize: 13.5, fontFamily: fontFamilies.semibold },
  portionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xl,
  },
  portionButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  portionButtonText: { fontSize: 26, fontWeight: '600', lineHeight: 30 },
  portionNumber: { fontSize: 46, fontWeight: '700', minWidth: 72, textAlign: 'center' },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.lg,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  toggleTextWrap: { flex: 1, minWidth: 0 },
  toggleTitle: { fontSize: 14.5, fontFamily: fontFamilies.semibold },
  toggleSub: { fontSize: 12.5, fontFamily: fontFamilies.regular, marginTop: 2 },
  checkbox: {
    width: 26,
    height: 26,
    borderRadius: 8,
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
  },
  confirmButton: {
    flex: 2,
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
});
