import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useThemeColors, typography, spacing, radius } from '../../theme';
import { usePreferences } from '../../store/PreferencesContext';
import { OnboardingLayout } from './OnboardingLayout';

interface Props {
  onNext: () => void;
}

export function AlcoholFilterScreen({ onNext }: Props) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { preferences, updatePreferences } = usePreferences();
  const [hide, setHide] = useState(preferences.hideAlcohol);

  const handleNext = async () => {
    await updatePreferences({ hideAlcohol: hide });
    onNext();
  };

  return (
    <OnboardingLayout
      step={4}
      totalSteps={7}
      title={t('onboarding.alcoholTitle')}
      description={t('onboarding.alcoholDescription')}
      onNext={handleNext}
    >
      <View style={styles.options}>
        {[true, false].map((value) => (
          <Pressable
            key={String(value)}
            style={[
              styles.option,
              {
                backgroundColor: hide === value ? colors.primaryLight : colors.surface,
                borderColor: hide === value ? colors.primary : colors.border,
              },
            ]}
            onPress={() => setHide(value)}
          >
            <Text
              style={[
                typography.h3,
                { color: hide === value ? colors.primary : colors.text },
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
