import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useThemeColors, typography, spacing, radius } from '../../theme';
import { usePreferences } from '../../store/PreferencesContext';
import { OnboardingLayout } from './OnboardingLayout';

interface Props {
  onNext: () => void;
}

export function ExcludeFoodsScreen({ onNext }: Props) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { preferences, updatePreferences } = usePreferences();
  const [foods, setFoods] = useState<string[]>(preferences.excludedFoods);
  const [input, setInput] = useState('');

  const addFood = () => {
    const trimmed = input.trim();
    if (trimmed && !foods.includes(trimmed)) {
      setFoods([...foods, trimmed]);
    }
    setInput('');
  };

  const removeFood = (food: string) => {
    setFoods(foods.filter((f) => f !== food));
  };

  const handleNext = async () => {
    await updatePreferences({ excludedFoods: foods });
    onNext();
  };

  return (
    <OnboardingLayout
      step={5}
      totalSteps={7}
      title={t('onboarding.excludeTitle')}
      description={t('onboarding.excludeDescription')}
      onNext={handleNext}
      onSkip={onNext}
    >
      <View style={styles.inputRow}>
        <TextInput
          style={[
            styles.input,
            {
              backgroundColor: colors.surface,
              borderColor: colors.border,
              color: colors.text,
            },
          ]}
          placeholder={t('onboarding.excludePlaceholder')}
          placeholderTextColor={colors.textTertiary}
          value={input}
          onChangeText={setInput}
          onSubmitEditing={addFood}
          returnKeyType="done"
        />
      </View>

      <View style={styles.tags}>
        {foods.map((food) => (
          <Pressable
            key={food}
            style={[styles.tag, { backgroundColor: colors.primaryLight, borderColor: colors.primary }]}
            onPress={() => removeFood(food)}
          >
            <Text style={[typography.bodySmall, { color: colors.primary }]}>
              {food} ✕
            </Text>
          </Pressable>
        ))}
      </View>
    </OnboardingLayout>
  );
}

const styles = StyleSheet.create({
  inputRow: {
    marginBottom: spacing.md,
  },
  input: {
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    fontSize: 16,
  },
  tags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  tag: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.xl,
    borderWidth: 1,
  },
});
