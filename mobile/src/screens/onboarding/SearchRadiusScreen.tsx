import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useThemeColors, typography, spacing } from '../../theme';
import { usePreferences } from '../../store/PreferencesContext';
import { OnboardingLayout } from './OnboardingLayout';

interface Props {
  onNext: () => void;
}

export function SearchRadiusScreen({ onNext }: Props) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { preferences, updatePreferences } = usePreferences();
  const [radius, setRadius] = useState(preferences.searchRadiusKm);

  // Simple step buttons since RN doesn't have a native slider without extra deps
  const steps = [1, 5, 10, 15, 25, 50, 100];

  const handleNext = async () => {
    await updatePreferences({ searchRadiusKm: radius });
    onNext();
  };

  return (
    <OnboardingLayout
      step={1}
      totalSteps={7}
      title={t('onboarding.radiusTitle')}
      description={t('onboarding.radiusDescription')}
      onNext={handleNext}
    >
      <View style={styles.center}>
        <Text style={[typography.h1, { color: colors.primary, fontSize: 56 }]}>
          {radius}
        </Text>
        <Text style={[typography.body, { color: colors.textSecondary }]}>
          {t('onboarding.radiusUnit')}
        </Text>

        <View style={styles.steps}>
          {steps.map((s) => (
            <View
              key={s}
              style={[
                styles.stepButton,
                {
                  backgroundColor: s === radius ? colors.primary : colors.surface,
                  borderColor: s === radius ? colors.primary : colors.border,
                },
              ]}
            >
              <Text
                style={[
                  typography.buttonSmall,
                  { color: s === radius ? '#FFFFFF' : colors.text },
                ]}
                onPress={() => setRadius(s)}
              >
                {s}
              </Text>
            </View>
          ))}
        </View>
      </View>
    </OnboardingLayout>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  steps: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: spacing.sm,
    marginTop: spacing.xl,
  },
  stepButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: 20,
    borderWidth: 1,
  },
});
