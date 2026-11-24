import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useThemeColors, typography, spacing, radius } from '../../theme';
import { usePreferences } from '../../store/PreferencesContext';
import { Allergy } from '../../types';
import { OnboardingLayout } from './OnboardingLayout';

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

interface Props {
  onNext: () => void;
}

export function AllergiesScreen({ onNext }: Props) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { preferences, updatePreferences } = usePreferences();
  const [selected, setSelected] = useState<Set<Allergy>>(new Set(preferences.allergies));

  const toggle = (allergy: Allergy) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(allergy)) {
        next.delete(allergy);
      } else {
        next.add(allergy);
      }
      return next;
    });
  };

  const handleNext = async () => {
    await updatePreferences({ allergies: Array.from(selected) });
    onNext();
  };

  return (
    <OnboardingLayout
      step={2}
      totalSteps={7}
      title={t('onboarding.allergiesTitle')}
      description={t('onboarding.allergiesDescription')}
      onNext={handleNext}
      onSkip={onNext}
    >
      <View style={styles.grid}>
        {ALL_ALLERGIES.map((allergy) => {
          const isSelected = selected.has(allergy);
          return (
            <Pressable
              key={allergy}
              style={[
                styles.chip,
                {
                  backgroundColor: isSelected ? colors.primaryLight : colors.surface,
                  borderColor: isSelected ? colors.primary : colors.border,
                },
              ]}
              onPress={() => toggle(allergy)}
            >
              <Text
                style={[
                  typography.button,
                  { color: isSelected ? colors.primary : colors.text },
                ]}
              >
                {t(allergyKeys[allergy])}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </OnboardingLayout>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  chip: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.xl,
    borderWidth: 1.5,
  },
});
