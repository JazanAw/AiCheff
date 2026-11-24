import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { fontFamilies, useThemeColors } from '../../theme';
import type { ThemeColors } from '../../theme';
import { Icon } from './Icon';
import type { RecipeProvenanceBadge } from '../../utils/recipeProvenance';

interface Props {
  badge: RecipeProvenanceBadge;
  /**
   * `dark` switches the pill to a translucent-white style for use on top of
   * the swipe card's photo background. `light` is the default — used inside
   * the pantry-list card and recipe detail header.
   */
  variant?: 'light' | 'dark';
  size?: 'sm' | 'md';
}

interface Visuals {
  labelKey: string;
  icon: 'check' | 'sparkle' | 'info' | 'tag';
  /** Fallback hex used for the dark variant where theme colors don't carry. */
  accent: string;
  /** Theme key used to pick the colored background/text for the light variant. */
  toneKey: 'success' | 'primary' | 'info';
}

const VISUALS: Record<RecipeProvenanceBadge, Visuals> = {
  verified: {
    labelKey: 'cheffity.provenance.verified',
    icon: 'check',
    accent: '#10B981',
    toneKey: 'success',
  },
  ai_generated: {
    labelKey: 'cheffity.provenance.aiGenerated',
    icon: 'sparkle',
    accent: '#FF6B35',
    toneKey: 'primary',
  },
  ai_adapted: {
    labelKey: 'cheffity.provenance.aiAdapted',
    icon: 'sparkle',
    accent: '#FF6B35',
    toneKey: 'primary',
  },
  public_domain: {
    labelKey: 'cheffity.provenance.publicDomain',
    icon: 'info',
    accent: '#3B82F6',
    toneKey: 'info',
  },
};

export function ProvenanceBadge({ badge, variant = 'light', size = 'sm' }: Props) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const visuals = VISUALS[badge];

  const isDark = variant === 'dark';
  const styles = size === 'md' ? mdStyles : smStyles;

  const colorPair = isDark
    ? { bg: 'rgba(0,0,0,0.45)', fg: '#FFFFFF', border: 'rgba(255,255,255,0.5)' }
    : lightColors(visuals.toneKey, colors);

  return (
    <View
      style={[
        styles.pill,
        { backgroundColor: colorPair.bg, borderColor: colorPair.border },
      ]}
    >
      <Icon name={visuals.icon} size={size === 'md' ? 14 : 12} color={colorPair.fg} active />
      <Text
        style={[styles.label, { color: colorPair.fg }]}
        numberOfLines={1}
      >
        {t(visuals.labelKey)}
      </Text>
    </View>
  );
}

function lightColors(
  tone: Visuals['toneKey'],
  colors: ThemeColors,
): { bg: string; fg: string; border: string } {
  switch (tone) {
    case 'success':
      return { bg: colors.successLight, fg: colors.success, border: colors.success };
    case 'primary':
      return { bg: colors.primaryLight, fg: colors.primary, border: colors.primary };
    case 'info':
    default:
      // No dedicated "info" tone in the theme — use a neutral surface pill
      // with the accent baked into text/border so the badge still reads.
      return { bg: colors.surfaceElevated, fg: '#3B82F6', border: '#93C5FD' };
  }
}

const smStyles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 2,
    paddingHorizontal: 8,
    borderRadius: 999,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  label: {
    fontSize: 11,
    fontFamily: fontFamilies.bold,
    letterSpacing: 0.2,
  },
});

const mdStyles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  label: {
    fontSize: 12,
    fontFamily: fontFamilies.bold,
    letterSpacing: 0.2,
  },
});
