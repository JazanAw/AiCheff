import React from 'react';
import {
  Pressable,
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
import type { WeeklyPlanEntry } from '../../../types';

const DAY_KEYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

interface Props {
  visible: boolean;
  entry: WeeklyPlanEntry | null;
  /** Whether this entry's recipe is already marked cooked. */
  isCooked: boolean;
  /** Whether plan edit/remove are allowed (false for past days/weeks). */
  canModify: boolean;
  colors: ThemeColors;
  t: (k: string, opts?: Record<string, unknown>) => string;
  onClose: () => void;
  onViewRecipe: () => void;
  onEditPlan: () => void;
  onRemove: () => void;
  onToggleCooked: () => void;
  /** Log this recipe (× portions) as eaten today in the tracker. */
  onLogToTracking: () => void;
  /** Whether diet tracking is unlocked for this user. Hides the button if not. */
  trackingEnabled: boolean;
}

/**
 * Action sheet shown when a planned entry is tapped in the weekly planner.
 * Displays the entry's recipe, day, meal and portions plus the three actions
 * (view recipe / change plan / remove). Pure UI — the planner owns the logic.
 */
export function PlannedEntrySheet({
  visible,
  entry,
  isCooked,
  canModify,
  colors,
  t,
  onClose,
  onViewRecipe,
  onEditPlan,
  onRemove,
  onToggleCooked,
  onLogToTracking,
  trackingEnabled,
}: Props) {
  const insets = useSafeAreaInsets();
  const { gesture, sheetStyle, backdropStyle } = useSwipeToDismiss({
    visible,
    onDismiss: onClose,
    mode: 'standalone',
  });

  const portions = entry ? entry.portionOverride ?? entry.recipe.servings : 0;
  const metaLine = entry
    ? [
        t(`planner.days.${DAY_KEYS[entry.dayOfWeek]}`),
        t(`cheffity.mealTypes.${entry.mealType}`),
        t('planner.entrySheet.portions', { count: portions }),
      ].join('  ·  ')
    : '';

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={visible ? 'auto' : 'none'}>
      <Reanimated.View style={[styles.backdrop, backdropStyle]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
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

        <Text style={[styles.recipeName, { color: colors.text }]} numberOfLines={2}>
          {entry?.recipe.name ?? ''}
        </Text>
        <Text style={[styles.meta, { color: colors.textSecondary }]} numberOfLines={1}>
          {metaLine}
        </Text>

        {isCooked ? (
          <View style={[styles.cookedBanner, { backgroundColor: colors.accentLight }]}>
            <Icon name="check" size={14} color={colors.accent} strokeWidth={3} />
            <Text style={[styles.cookedBannerText, { color: colors.accent }]}>
              {t('planner.entrySheet.cookedBadge')}
            </Text>
          </View>
        ) : null}

        <View style={styles.actions}>
          <Pressable
            style={[styles.primaryButton, { backgroundColor: colors.primary }]}
            onPress={onViewRecipe}
          >
            <Icon name="info" size={18} color="#FFFFFF" />
            <Text style={[typography.button, { color: '#FFFFFF' }]}>
              {t('planner.entrySheet.viewRecipe')}
            </Text>
          </Pressable>

          {/* Cook status — always available, even in past weeks. */}
          <Pressable
            style={[
              styles.secondaryButton,
              isCooked
                ? { backgroundColor: colors.surface, borderColor: colors.border }
                : { backgroundColor: colors.accent, borderColor: colors.accent },
            ]}
            onPress={onToggleCooked}
          >
            <Icon
              name={isCooked ? 'close' : 'check'}
              size={18}
              color={isCooked ? colors.text : '#FFFFFF'}
              strokeWidth={isCooked ? 2 : 3}
            />
            <Text style={[typography.button, { color: isCooked ? colors.text : '#FFFFFF' }]}>
              {isCooked
                ? t('planner.entrySheet.markNotCooked')
                : t('planner.entrySheet.markCooked')}
            </Text>
          </Pressable>

          {trackingEnabled ? (
            <Pressable
              style={[styles.secondaryButton, { backgroundColor: colors.surface, borderColor: colors.border }]}
              onPress={onLogToTracking}
            >
              <Icon name="flame" size={18} color={colors.primary} />
              <Text style={[typography.button, { color: colors.text }]}>
                {t('diet.logFromPlanner')}
              </Text>
            </Pressable>
          ) : null}

          {canModify ? (
            <>
              <Pressable
                style={[styles.secondaryButton, { backgroundColor: colors.surface, borderColor: colors.border }]}
                onPress={onEditPlan}
              >
                <Icon name="sliders" size={18} color={colors.text} />
                <Text style={[typography.button, { color: colors.text }]}>
                  {t('planner.entrySheet.editPlan')}
                </Text>
              </Pressable>

              <Pressable
                style={[styles.secondaryButton, { backgroundColor: colors.errorLight, borderColor: colors.error }]}
                onPress={onRemove}
              >
                <Icon name="ban" size={18} color={colors.error} />
                <Text style={[typography.button, { color: colors.error }]}>
                  {t('planner.entrySheet.remove')}
                </Text>
              </Pressable>
            </>
          ) : (
            <Text style={[styles.pastHint, { color: colors.textTertiary }]}>
              {t('planner.entrySheet.pastReadOnly')}
            </Text>
          )}
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
    marginBottom: spacing.md,
  },
  recipeName: {
    ...typography.h3,
    textAlign: 'center',
  },
  meta: {
    ...typography.body,
    textAlign: 'center',
    marginTop: 4,
    marginBottom: spacing.lg,
  },
  cookedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    borderRadius: radius.md,
    marginBottom: spacing.md,
  },
  cookedBannerText: { ...typography.bodySmall, fontFamily: fontFamilies.bold },
  pastHint: { ...typography.bodySmall, textAlign: 'center', paddingVertical: spacing.sm },
  actions: { gap: spacing.sm },
  primaryButton: {
    paddingVertical: 15,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  secondaryButton: {
    paddingVertical: 15,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
});
