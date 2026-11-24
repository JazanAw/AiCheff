import React, { useState } from 'react';
import { usePreferences } from '../store/PreferencesContext';
import { LocationPermissionScreen } from '../screens/onboarding/LocationPermissionScreen';
import { SearchRadiusScreen } from '../screens/onboarding/SearchRadiusScreen';
import { AllergiesScreen } from '../screens/onboarding/AllergiesScreen';
import { HalalFilterScreen } from '../screens/onboarding/HalalFilterScreen';
import { AlcoholFilterScreen } from '../screens/onboarding/AlcoholFilterScreen';
import { ExcludeFoodsScreen } from '../screens/onboarding/ExcludeFoodsScreen';
import { PortionSizeScreen } from '../screens/onboarding/PortionSizeScreen';

const STEPS = [
  'location',
  'radius',
  'allergies',
  'halal',
  'alcohol',
  'exclude',
  'portions',
] as const;

export function OnboardingNavigator() {
  const [step, setStep] = useState(0);
  const { completeOnboarding } = usePreferences();

  const nextStep = () => {
    if (step < STEPS.length - 1) {
      setStep(step + 1);
    } else {
      completeOnboarding();
    }
  };

  switch (STEPS[step]) {
    case 'location':
      return <LocationPermissionScreen onNext={nextStep} />;
    case 'radius':
      return <SearchRadiusScreen onNext={nextStep} />;
    case 'allergies':
      return <AllergiesScreen onNext={nextStep} />;
    case 'halal':
      return <HalalFilterScreen onNext={nextStep} />;
    case 'alcohol':
      return <AlcoholFilterScreen onNext={nextStep} />;
    case 'exclude':
      return <ExcludeFoodsScreen onNext={nextStep} />;
    case 'portions':
      return <PortionSizeScreen onNext={nextStep} />;
    default:
      return <LocationPermissionScreen onNext={nextStep} />;
  }
}
