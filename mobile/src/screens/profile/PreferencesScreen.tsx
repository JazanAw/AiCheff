import React, { useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useThemeColors, typography, spacing, radius } from '../../theme';
import { usePreferences } from '../../store/PreferencesContext';
import { Allergy } from '../../types';

const ALL_ALLERGIES: Allergy[] = [
  'gluten', 'lactose', 'nuts', 'eggs', 'soy', 'fish', 'seafood', 'sesame',
];

const allergyKeys: Record<Allergy, string> = {
  gluten: 'onboarding.allergyGluten',
  lactose: 'onboarding.allergyLactose',
  nuts: 'onboarding.allergyNuts',
  eggs: 'onboarding.allergyEggs',
  soy: 'onboarding.allergySoy',
  fish: 'onboarding.allergyFish',
  seafood: 'onboarding.allergySeafood',
  sesame: 'onboarding.allergySesame',
};

const RADIUS_OPTIONS = [1, 5, 10, 15, 25, 50, 100];

interface Props {
  onBack: () => void;
}

export function PreferencesScreen({ onBack }: Props) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { preferences, updatePreferences } = usePreferences();
  const [excludeInput, setExcludeInput] = useState('');

  const toggleAllergy = (allergy: Allergy) => {
    const current = new Set(preferences.allergies);
    if (current.has(allergy)) {
      current.delete(allergy);
    } else {
      current.add(allergy);
    }
    updatePreferences({ allergies: Array.from(current) });
  };

  const addExcluded = () => {
    const trimmed = excludeInput.trim();
    if (trimmed && !preferences.excludedFoods.includes(trimmed)) {
      updatePreferences({ excludedFoods: [...preferences.excludedFoods, trimmed] });
    }
    setExcludeInput('');
  };

  const removeExcluded = (food: string) => {
    updatePreferences({ excludedFoods: preferences.excludedFoods.filter((f) => f !== food) });
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={onBack}>
          <Text style={[typography.button, { color: colors.primary }]}>{t('common.back')}</Text>
        </Pressable>
        <Text style={[typography.h3, { color: colors.text }]}>{t('profile.preferences')}</Text>
        <View style={{ width: 50 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* Search Radius */}
        <Text style={[typography.label, { color: colors.textSecondary }]}>
          {t('onboarding.radiusTitle')}
        </Text>
        <View style={styles.chipRow}>
          {RADIUS_OPTIONS.map((r) => {
            const active = preferences.searchRadiusKm === r;
            return (
              <Pressable
                key={r}
                style={[styles.chip, {
                  backgroundColor: active ? colors.primary : colors.surface,
                  borderColor: active ? colors.primary : colors.border,
                }]}
                onPress={() => updatePreferences({ searchRadiusKm: r })}
              >
                <Text style={[typography.buttonSmall, { color: active ? '#FFF' : colors.text }]}>
                  {r} km
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Allergies */}
        <Text style={[typography.label, { color: colors.textSecondary, marginTop: spacing.xl }]}>
          {t('onboarding.allergiesTitle')}
        </Text>
        <View style={styles.chipRow}>
          {ALL_ALLERGIES.map((allergy) => {
            const active = preferences.allergies.includes(allergy);
            return (
              <Pressable
                key={allergy}
                style={[styles.chip, {
                  backgroundColor: active ? colors.primaryLight : colors.surface,
                  borderColor: active ? colors.primary : colors.border,
                }]}
                onPress={() => toggleAllergy(allergy)}
              >
                <Text style={[typography.buttonSmall, { color: active ? colors.primary : colors.text }]}>
                  {t(allergyKeys[allergy])}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Halal */}
        <Text style={[typography.label, { color: colors.textSecondary, marginTop: spacing.xl }]}>
          {t('onboarding.halalTitle')}
        </Text>
        <View style={styles.toggleRow}>
          {[true, false].map((val) => (
            <Pressable
              key={String(val)}
              style={[styles.toggleButton, {
                backgroundColor: preferences.halalFilter === val ? colors.primary : colors.surface,
                borderColor: preferences.halalFilter === val ? colors.primary : colors.border,
              }]}
              onPress={() => updatePreferences({ halalFilter: val })}
            >
              <Text style={[typography.button, {
                color: preferences.halalFilter === val ? '#FFF' : colors.text,
              }]}>
                {val ? t('common.yes') : t('common.no')}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* Alcohol */}
        <Text style={[typography.label, { color: colors.textSecondary, marginTop: spacing.xl }]}>
          {t('onboarding.alcoholTitle')}
        </Text>
        <View style={styles.toggleRow}>
          {[true, false].map((val) => (
            <Pressable
              key={String(val)}
              style={[styles.toggleButton, {
                backgroundColor: preferences.hideAlcohol === val ? colors.primary : colors.surface,
                borderColor: preferences.hideAlcohol === val ? colors.primary : colors.border,
              }]}
              onPress={() => updatePreferences({ hideAlcohol: val })}
            >
              <Text style={[typography.button, {
                color: preferences.hideAlcohol === val ? '#FFF' : colors.text,
              }]}>
                {val ? t('common.yes') : t('common.no')}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* Excluded foods */}
        <Text style={[typography.label, { color: colors.textSecondary, marginTop: spacing.xl }]}>
          {t('onboarding.excludeTitle')}
        </Text>
        <View style={styles.excludeRow}>
          <TextInput
            style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text, flex: 1 }]}
            placeholder={t('onboarding.excludePlaceholder')}
            placeholderTextColor={colors.textTertiary}
            value={excludeInput}
            onChangeText={setExcludeInput}
            onSubmitEditing={addExcluded}
            returnKeyType="done"
          />
        </View>
        <View style={styles.chipRow}>
          {preferences.excludedFoods.map((food) => (
            <Pressable
              key={food}
              style={[styles.chip, { backgroundColor: colors.errorLight, borderColor: colors.error }]}
              onPress={() => removeExcluded(food)}
            >
              <Text style={[typography.bodySmall, { color: colors.error }]}>{food} ✕</Text>
            </Pressable>
          ))}
        </View>

        {/* Portion size */}
        <Text style={[typography.label, { color: colors.textSecondary, marginTop: spacing.xl }]}>
          {t('onboarding.portionTitle')}
        </Text>
        <View style={styles.portionRow}>
          <Pressable
            style={[styles.portionButton, { backgroundColor: colors.surface, borderColor: colors.border }]}
            onPress={() => updatePreferences({ defaultPortionSize: Math.max(1, preferences.defaultPortionSize - 1) })}
          >
            <Text style={[typography.h2, { color: colors.text }]}>−</Text>
          </Pressable>
          <Text style={[typography.h1, { color: colors.primary }]}>{preferences.defaultPortionSize}</Text>
          <Pressable
            style={[styles.portionButton, { backgroundColor: colors.surface, borderColor: colors.border }]}
            onPress={() => updatePreferences({ defaultPortionSize: Math.min(12, preferences.defaultPortionSize + 1) })}
          >
            <Text style={[typography.h2, { color: colors.text }]}>+</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
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
    padding: spacing.lg,
    paddingBottom: spacing.xxl * 2,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  chip: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
    borderWidth: 1,
  },
  toggleRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  toggleButton: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
  },
  excludeRow: {
    marginTop: spacing.sm,
  },
  input: {
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    fontSize: 16,
  },
  portionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xl,
    marginTop: spacing.md,
  },
  portionButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
