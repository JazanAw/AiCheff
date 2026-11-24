import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useThemeColors, typography, spacing, radius } from '../../theme';
import { usePreferences } from '../../store/PreferencesContext';
import { OnboardingLayout } from './OnboardingLayout';

interface Props {
  onNext: () => void;
}

export function HalalFilterScreen({ onNext }: Props) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { preferences, updatePreferences } = usePreferences();
  const [halal, setHalal] = useState(preferences.halalFilter);

  const handleNext = async () => {
    await updatePreferences({ halalFilter: halal });
    onNext();
  };

  return (
    <OnboardingLayout
      step={3}
      totalSteps={7}
      title={t('onboarding.halalTitle')}
      description={t('onboarding.halalDescription')}
      onNext={handleNext}
    >
      <View style={styles.options}>
        {[true, false].map((value) => (
          <Pressable
            key={String(value)}
            style={[
              styles.option,
              {
                backgroundColor: halal === value ? colors.primaryLight : colors.surface,
                borderColor: halal === value ? colors.primary : colors.border,
              },
            ]}
            onPress={() => setHalal(value)}
          >
            <Text
              style={[
                typography.h3,
                { color: halal === value ? colors.primary : colors.text },
              ]}
            >
              {value ? t('common.yes') : t('common.no')}
            </Text>
          </Pressable>
        ))}
      </View>
    </OnboardingLayout>
  );
}

const styles = StyleSheet.create({
  options: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  option: {
    flex: 1,
    paddingVertical: spacing.xl,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    alignItems: 'center',
  },
});
