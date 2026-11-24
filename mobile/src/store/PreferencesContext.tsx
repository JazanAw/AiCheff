import React, { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '../config/supabase';
import { useAuth } from './AuthContext';
import type { Allergy, UserPreferences } from '../types';

const defaultPreferences: UserPreferences = {
  searchRadiusKm: 15,
  allergies: [],
  halalFilter: false,
  hideAlcohol: false,
  excludedFoods: [],
  defaultPortionSize: 2,
};

interface PreferencesState {
  preferences: UserPreferences;
  isLoading: boolean;
  onboardingCompleted: boolean;
  updatePreferences: (update: Partial<UserPreferences>) => Promise<void>;
  completeOnboarding: () => Promise<void>;
}

const PreferencesContext = createContext<PreferencesState | null>(null);

interface PreferencesRow {
  search_radius_km: number | null;
  allergies: Allergy[] | null;
  halal_filter: boolean | null;
  hide_alcohol: boolean | null;
  excluded_foods: string[] | null;
  default_portion_size: number | null;
  latitude: number | null;
  longitude: number | null;
}

function rowToPrefs(row: PreferencesRow | null): UserPreferences {
  if (!row) return { ...defaultPreferences };
  return {
    searchRadiusKm:     row.search_radius_km     ?? defaultPreferences.searchRadiusKm,
    allergies:          row.allergies            ?? [],
    halalFilter:        row.halal_filter         ?? false,
    hideAlcohol:        row.hide_alcohol         ?? false,
    excludedFoods:      row.excluded_foods       ?? [],
    defaultPortionSize: row.default_portion_size ?? defaultPreferences.defaultPortionSize,
    latitude:           row.latitude  ?? undefined,
    longitude:          row.longitude ?? undefined,
  };
}

function prefsToRow(update: Partial<UserPreferences>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (update.searchRadiusKm     !== undefined) out.search_radius_km     = update.searchRadiusKm;
  if (update.allergies          !== undefined) out.allergies            = update.allergies;
  if (update.halalFilter        !== undefined) out.halal_filter         = update.halalFilter;
  if (update.hideAlcohol        !== undefined) out.hide_alcohol         = update.hideAlcohol;
  if (update.excludedFoods      !== undefined) out.excluded_foods       = update.excludedFoods;
  if (update.defaultPortionSize !== undefined) out.default_portion_size = update.defaultPortionSize;
  if (update.latitude           !== undefined) out.latitude             = update.latitude;
  if (update.longitude          !== undefined) out.longitude            = update.longitude;
  return out;
}

export function PreferencesProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [preferences, setPreferences] = useState<UserPreferences>(defaultPreferences);
  const [onboardingCompleted, setOnboardingCompleted] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    if (!user) {
      setPreferences(defaultPreferences);
      setOnboardingCompleted(false);
      setIsLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setIsLoading(true);
    (async () => {
      const [prefsRes, profileRes] = await Promise.all([
        supabase
          .from('user_preferences')
          .select('search_radius_km, allergies, halal_filter, hide_alcohol, excluded_foods, default_portion_size, latitude, longitude')
          .eq('user_id', user.id)
          .maybeSingle(),
        supabase
          .from('profiles')
          .select('onboarding_completed')
          .eq('id', user.id)
          .maybeSingle(),
      ]);

      if (cancelled) return;

      setPreferences(rowToPrefs((prefsRes.data as PreferencesRow | null) ?? null));
      setOnboardingCompleted(Boolean((profileRes.data as { onboarding_completed?: boolean } | null)?.onboarding_completed));
      setIsLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [user]);

  const updatePreferences = async (update: Partial<UserPreferences>) => {
    if (!user) return;
    const next = { ...preferences, ...update };
    setPreferences(next);

    const { error } = await supabase
      .from('user_preferences')
      .upsert(
        { user_id: user.id, ...prefsToRow(update) },
        { onConflict: 'user_id' },
      );
    if (error) {
      console.warn('[PreferencesContext] updatePreferences failed:', error.message);
    }
  };

  const completeOnboarding = async () => {
    if (!user) return;
    setOnboardingCompleted(true);

    const { error } = await supabase
      .from('profiles')
      .update({ onboarding_completed: true })
      .eq('id', user.id);
    if (error) {
      console.warn('[PreferencesContext] completeOnboarding failed:', error.message);
    }
  };

  return (
    <PreferencesContext.Provider
      value={{ preferences, isLoading, onboardingCompleted, updatePreferences, completeOnboarding }}
    >
      {children}
    </PreferencesContext.Provider>
  );
}

export function usePreferences(): PreferencesState {
  const context = useContext(PreferencesContext);
  if (!context) {
    throw new Error('usePreferences must be used within PreferencesProvider');
  }
  return context;
}
