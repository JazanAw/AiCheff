import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useThemeColors, typography, spacing } from '../../theme';
import { usePreferences } from '../../store/PreferencesContext';
import { OnboardingLayout } from './OnboardingLayout';

interface Props {
  onNext: () => void;
}

export function PortionSizeScreen({ onNext }: Props) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { preferences, updatePreferences } = usePreferences();
  const [portions, setPortions] = useState(preferences.defaultPortionSize);

  const handleNext = async () => {
    await updatePreferences({ defaultPortionSize: portions });
    onNext();
  };

  return (
    <OnboardingLayout
      step={6}
      totalSteps={7}
      title={t('onboarding.portionTitle')}
      description={t('onboarding.portionDescription')}
      onNext={handleNext}
      nextLabel={t('common.done')}
    >
      <View style={styles.center}>
        <Text style={[typography.h1, { color: colors.primary, fontSize: 64 }]}>
          {portions}
        </Text>
        <Text style={[typography.body, { color: colors.textSecondary }]}>
          {t('onboarding.portionUnit')}
        </Text>

        <View style={styles.controls}>
          <Pressable
            style={[styles.controlButton, { backgroundColor: colors.surface, borderColor: colors.border }]}
            onPress={() => setPortions(Math.max(1, portions - 1))}
          >
            <Text style={[typography.h2, { color: colors.text }]}>−</Text>
          </Pressable>
          <Pressable
            style={[styles.controlButton, { backgroundColor: colors.surface, borderColor: colors.border }]}
            onPress={() => setPortions(Math.min(12, portions + 1))}
          >
            <Text style={[typography.h2, { color: colors.text }]}>+</Text>
          </Pressable>
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
  controls: {
    flexDirection: 'row',
    gap: spacing.lg,
    marginTop: spacing.xl,
  },
  controlButton: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
