import React from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Reanimated from 'react-native-reanimated';
import { useSwipeToDismiss } from '../../../components/common/useSwipeToDismiss';
import { fontFamilies, radius, spacing, typography } from '../../../theme';
import type { ThemeColors } from '../../../theme';
import { Icon } from '../../../components/common/Icon';
import type { Recipe } from '../../../types';

interface Props {
  visible: boolean;
  loading: boolean;
  recipes: Recipe[];
  missingProtein: number;
  colors: ThemeColors;
  t: (k: string, opts?: Record<string, unknown>) => string;
  onClose: () => void;
  onLog: (recipe: Recipe) => void;
}

/**
 * "Dir fehlen noch X g Protein" → a short list of high-protein recipes, sorted
 * by protein per serving. Tapping one logs a single portion to today's tracker
 * (closing the loop without leaving the screen). Cheffity connection, MVP-level.
 */
export function HighProteinSheet({
  visible,
  loading,
  recipes,
  missingProtein,
  colors,
  t,
  onClose,
  onLog,
}: Props) {
  const insets = useSafeAreaInsets();
  const { gesture, sheetStyle, scrollHandler, scrollRef } = useSwipeToDismiss({
    visible,
    onDismiss: onClose,
  });

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <GestureHandlerRootView style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <GestureDetector gesture={gesture}>
        <Reanimated.View
          style={[
            styles.sheet,
            { backgroundColor: colors.surfaceElevated, paddingBottom: insets.bottom + spacing.lg },
            sheetStyle,
          ]}
        >
          <View style={[styles.handleBar, { backgroundColor: colors.border }]} />
          <Text style={[styles.title, { color: colors.text }]}>
            {t('diet.cheffity.sheetTitle')}
          </Text>
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
            {t('diet.cheffity.missingProtein', { grams: missingProtein })}
          </Text>

          {loading ? (
            <View style={styles.loading}>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : recipes.length === 0 ? (
            <Text style={[styles.empty, { color: colors.textTertiary }]}>
              {t('common.noResults')}
            </Text>
          ) : (
            <Reanimated.ScrollView
              ref={scrollRef}
              onScroll={scrollHandler}
              scrollEventThrottle={16}
              style={{ maxHeight: 420 }}
              keyboardShouldPersistTaps="handled"
            >
              {recipes.map((recipe) => {
                const protein = recipe.nutritionPerServing?.protein;
                const kcal = recipe.nutritionPerServing?.calories;
                return (
                  <View
                    key={recipe.id}
                    style={[styles.row, { borderBottomColor: colors.borderLight }]}
                  >
                    <View style={styles.rowBody}>
                      <Text style={[styles.rowName, { color: colors.text }]} numberOfLines={1}>
                        {recipe.name}
                      </Text>
                      <Text style={[styles.rowMeta, { color: colors.textSecondary }]}>
                        {protein != null ? `${Math.round(protein)} g ${t('diet.proteinShort')}` : '–'}
                        {kcal != null ? `  ·  ${Math.round(kcal)} kcal` : ''}
                      </Text>
                    </View>
                    <Pressable
                      style={[styles.logButton, { backgroundColor: colors.primaryLight }]}
                      onPress={() => onLog(recipe)}
                      accessibilityRole="button"
                      accessibilityLabel={t('diet.cheffity.logRecipe')}
                    >
                      <Icon name="plus" size={16} color={colors.primary} />
                      <Text style={[styles.logButtonText, { color: colors.primary }]}>
                        {t('diet.cheffity.logRecipe')}
                      </Text>
                    </Pressable>
                  </View>
                );
              })}
            </Reanimated.ScrollView>
          )}

          <Pressable
            style={[styles.closeButton, { borderColor: colors.border }]}
            onPress={onClose}
          >
            <Text style={[typography.button, { color: colors.text }]}>{t('common.done')}</Text>
          </Pressable>
        </Reanimated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: {
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
  },
  handleBar: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: spacing.md },
  title: { ...typography.h3 },
  subtitle: { ...typography.bodySmall, marginTop: 2, marginBottom: spacing.md },
  loading: { paddingVertical: spacing.xl, alignItems: 'center' },
  empty: { ...typography.bodySmall, paddingVertical: spacing.xl, textAlign: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    gap: spacing.sm,
  },
  rowBody: { flex: 1, minWidth: 0 },
  rowName: { fontFamily: fontFamilies.semibold, fontSize: 14.5 },
  rowMeta: { fontFamily: fontFamilies.regular, fontSize: 12, marginTop: 2 },
  logButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.md,
  },
  logButtonText: { fontFamily: fontFamilies.semibold, fontSize: 12.5 },
  closeButton: {
    marginTop: spacing.md,
    paddingVertical: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
  },
});
