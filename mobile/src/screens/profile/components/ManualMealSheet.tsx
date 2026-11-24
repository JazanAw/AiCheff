import React, { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Reanimated from 'react-native-reanimated';
import { useSwipeToDismiss } from '../../../components/common/useSwipeToDismiss';
import { fontFamilies, radius, spacing, typography } from '../../../theme';
import type { ThemeColors } from '../../../theme';
import { Icon } from '../../../components/common/Icon';
import type { MealCategory } from '../../../types';

const CATEGORIES: MealCategory[] = ['breakfast', 'lunch', 'dinner', 'snack'];
const SATIETY_LEVELS = [1, 2, 3, 4, 5] as const;

export interface ManualMealDraft {
  name: string;
  category: MealCategory;
  calories?: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  satiety?: number;
}

interface Props {
  visible: boolean;
  saving: boolean;
  colors: ThemeColors;
  t: (k: string, opts?: Record<string, unknown>) => string;
  onCancel: () => void;
  onSubmit: (draft: ManualMealDraft) => void;
}

function toNumber(value: string): number | undefined {
  const n = Number(value.replace(',', '.'));
  return value.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Quick manual food entry (Proteinriegel, Banane, …). Name is required; the
 * rest is optional. Nutrition is treated as estimated by the caller.
 */
export function ManualMealSheet({ visible, saving, colors, t, onCancel, onSubmit }: Props) {
  const insets = useSafeAreaInsets();
  const { gesture, sheetStyle, scrollHandler, scrollRef } = useSwipeToDismiss({
    visible,
    onDismiss: onCancel,
  });
  const [name, setName] = useState('');
  const [category, setCategory] = useState<MealCategory>('snack');
  const [calories, setCalories] = useState('');
  const [protein, setProtein] = useState('');
  const [carbs, setCarbs] = useState('');
  const [fat, setFat] = useState('');
  const [satiety, setSatiety] = useState<number | undefined>(undefined);

  // Reset the form each time the sheet opens.
  useEffect(() => {
    if (visible) {
      setName('');
      setCategory('snack');
      setCalories('');
      setProtein('');
      setCarbs('');
      setFat('');
      setSatiety(undefined);
    }
  }, [visible]);

  const canSave = name.trim().length > 0 && !saving;

  const handleSave = () => {
    if (!canSave) return;
    onSubmit({
      name: name.trim(),
      category,
      calories: toNumber(calories),
      protein: toNumber(protein),
      carbs: toNumber(carbs),
      fat: toNumber(fat),
      satiety,
    });
  };

  const inputStyle = [
    styles.input,
    { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text },
  ];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <GestureHandlerRootView style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.kav}
        >
          <GestureDetector gesture={gesture}>
          <Reanimated.View
            style={[
              styles.sheet,
              { backgroundColor: colors.surfaceElevated, paddingBottom: insets.bottom + spacing.lg },
              sheetStyle,
            ]}
          >
            <View style={[styles.handleBar, { backgroundColor: colors.border }]} />
            <View style={styles.headerRow}>
              <Text style={[styles.title, { color: colors.text }]}>{t('diet.manual.title')}</Text>
              <Pressable
                onPress={onCancel}
                style={[styles.closeButton, { backgroundColor: colors.surface }]}
                accessibilityRole="button"
                accessibilityLabel={t('common.cancel')}
              >
                <Icon name="close" size={17} color={colors.textSecondary} />
              </Pressable>
            </View>

            <Reanimated.ScrollView
              ref={scrollRef}
              onScroll={scrollHandler}
              scrollEventThrottle={16}
              keyboardShouldPersistTaps="handled"
              style={{ maxHeight: 460 }}
            >
              <Text style={[styles.fieldLabel, { color: colors.text }]}>{t('diet.manual.name')}</Text>
              <TextInput
                style={inputStyle}
                value={name}
                onChangeText={setName}
                placeholder={t('diet.manual.namePlaceholder')}
                placeholderTextColor={colors.textTertiary}
                autoFocus
              />

              <Text style={[styles.fieldLabel, { color: colors.text }]}>{t('diet.manual.category')}</Text>
              <View style={styles.segmentRow}>
                {CATEGORIES.map((c) => {
                  const active = category === c;
                  return (
                    <Pressable
                      key={c}
                      style={[
                        styles.segment,
                        {
                          backgroundColor: active ? colors.primary : colors.surface,
                          borderColor: active ? colors.primary : colors.border,
                        },
                      ]}
                      onPress={() => setCategory(c)}
                    >
                      <Text
                        style={[styles.segmentText, { color: active ? '#FFFFFF' : colors.text }]}
                      >
                        {t(`diet.category.${c}`)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              <View style={styles.grid}>
                <View style={styles.gridItem}>
                  <Text style={[styles.fieldLabel, { color: colors.text }]}>{t('diet.manual.calories')}</Text>
                  <TextInput
                    style={inputStyle}
                    value={calories}
                    onChangeText={setCalories}
                    keyboardType="numeric"
                    placeholder="0"
                    placeholderTextColor={colors.textTertiary}
                  />
                </View>
                <View style={styles.gridItem}>
                  <Text style={[styles.fieldLabel, { color: colors.text }]}>{t('diet.manual.protein')}</Text>
                  <TextInput
                    style={inputStyle}
                    value={protein}
                    onChangeText={setProtein}
                    keyboardType="numeric"
                    placeholder="0"
                    placeholderTextColor={colors.textTertiary}
                  />
                </View>
              </View>

              <View style={styles.grid}>
                <View style={styles.gridItem}>
                  <Text style={[styles.fieldLabel, { color: colors.text }]}>{t('diet.manual.carbs')}</Text>
                  <TextInput
                    style={inputStyle}
                    value={carbs}
                    onChangeText={setCarbs}
                    keyboardType="numeric"
                    placeholder="0"
                    placeholderTextColor={colors.textTertiary}
                  />
                </View>
                <View style={styles.gridItem}>
                  <Text style={[styles.fieldLabel, { color: colors.text }]}>{t('diet.manual.fat')}</Text>
                  <TextInput
                    style={inputStyle}
                    value={fat}
                    onChangeText={setFat}
                    keyboardType="numeric"
                    placeholder="0"
                    placeholderTextColor={colors.textTertiary}
                  />
                </View>
              </View>

              <Text style={[styles.fieldLabel, { color: colors.text }]}>
                {t('diet.manual.satiety')}
                <Text style={{ color: colors.textTertiary, fontFamily: fontFamilies.regular }}>
                  {`  ·  ${t('diet.manual.satietyHint')}`}
                </Text>
              </Text>
              <View style={styles.segmentRow}>
                {SATIETY_LEVELS.map((level) => {
                  // Cumulative highlight (1–5), like a rating scale.
                  const active = satiety != null && satiety >= level;
                  return (
                    <Pressable
                      key={level}
                      style={[
                        styles.satietyDot,
                        {
                          backgroundColor: active ? colors.primaryLight : colors.surface,
                          borderColor: active ? colors.primary : colors.border,
                        },
                      ]}
                      onPress={() => setSatiety(satiety === level ? undefined : level)}
                    >
                      <Text style={[styles.segmentText, { color: active ? colors.primary : colors.textSecondary }]}>
                        {level}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </Reanimated.ScrollView>

            <Pressable
              style={[styles.primaryButton, { backgroundColor: colors.primary, opacity: canSave ? 1 : 0.5 }]}
              onPress={handleSave}
              disabled={!canSave}
            >
              <Text style={[typography.button, { color: '#FFFFFF' }]}>
                {saving ? t('diet.loading') : t('diet.manual.save')}
              </Text>
            </Pressable>
          </Reanimated.View>
          </GestureDetector>
        </KeyboardAvoidingView>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  kav: { width: '100%' },
  sheet: {
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
  },
  handleBar: { width: 40, height: 5, borderRadius: 3, alignSelf: 'center', marginBottom: spacing.md },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  title: { fontFamily: fontFamilies.displaySemibold, fontSize: 21, letterSpacing: -0.3 },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fieldLabel: {
    fontFamily: fontFamilies.semibold,
    fontSize: 12.5,
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  input: {
    paddingVertical: 11,
    paddingHorizontal: spacing.md,
    borderRadius: 12,
    borderWidth: 1,
    fontSize: 15,
  },
  segmentRow: { flexDirection: 'row', gap: spacing.xs, flexWrap: 'wrap' },
  segment: {
    flexGrow: 1,
    paddingVertical: 9,
    borderRadius: 11,
    borderWidth: 1,
    alignItems: 'center',
  },
  segmentText: { fontFamily: fontFamilies.semibold, fontSize: 12.5 },
  satietyDot: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 11,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  grid: { flexDirection: 'row', gap: spacing.sm },
  gridItem: { flex: 1 },
  primaryButton: {
    marginTop: spacing.lg,
    paddingVertical: 15,
    borderRadius: 14,
    alignItems: 'center',
    shadowColor: '#FF6B35',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.28,
    shadowRadius: 16,
    elevation: 4,
  },
});
