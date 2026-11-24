import React from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import * as Location from 'expo-location';
import { useThemeColors, typography } from '../../theme';
import { usePreferences } from '../../store/PreferencesContext';
import { OnboardingLayout } from './OnboardingLayout';

interface Props {
  onNext: () => void;
}

export function LocationPermissionScreen({ onNext }: Props) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { updatePreferences } = usePreferences();

  const requestLocation = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status === 'granted') {
      const location = await Location.getCurrentPositionAsync({});
      await updatePreferences({
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
      });
    } else {
      Alert.alert(t('common.error'), t('onboarding.locationSkip'));
    }
    onNext();
  };

  return (
    <OnboardingLayout
      step={0}
      totalSteps={7}
      title={t('onboarding.locationTitle')}
      description={t('onboarding.locationDescription')}
      onNext={requestLocation}
      onSkip={onNext}
      nextLabel={t('onboarding.locationButton')}
    >
      <View style={styles.iconContainer}>
        <View style={[styles.iconCircle, { backgroundColor: colors.primaryLight }]}>
          <Text style={[typography.h1, { color: colors.primary, fontSize: 48 }]}>
            {'📍'}
          </Text>
        </View>
      </View>
    </OnboardingLayout>
  );
}

const styles = StyleSheet.create({
  iconContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  iconCircle: {
    width: 120,
    height: 120,
    borderRadius: 60,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
