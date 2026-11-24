import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { fontFamilies } from '../../theme';
import type { ThemeColors } from '../../theme';
import { Icon } from './Icon';

// Shared "Kochen mit Lager" visual primitives (Claude Design handoff).
// Used by PantryRecipesView cards and the RecipeDetailScreen coverage callout
// so the chip + micro-bar language stays identical across both surfaces.

export type CoverageTone = 'success' | 'warning' | 'deal' | 'miss';
export type ChipGlyph = 'check' | 'dot' | 'spark' | 'none';

function toneColors(
  tone: CoverageTone,
  colors: ThemeColors,
): { bg: string; fg: string } {
  switch (tone) {
    case 'success':
      return { bg: colors.successLight, fg: colors.success };
    case 'warning':
      return { bg: colors.warningLight, fg: colors.warning };
    case 'deal':
      return { bg: colors.dealBadge, fg: colors.deal };
    case 'miss':
    default:
      return { bg: colors.surface, fg: colors.textSecondary };
  }
}

/** Low-saturation status pill with an optional tiny glyph. */
export function CoverageChip({
  tone,
  label,
  glyph = 'none',
  colors,
}: {
  tone: CoverageTone;
  label: string;
  glyph?: ChipGlyph;
  colors: ThemeColors;
}) {
  const { bg, fg } = toneColors(tone, colors);
  return (
    <View style={[styles.chip, { backgroundColor: bg }]}>
      {glyph === 'dot' && <View style={[styles.dot, { backgroundColor: fg }]} />}
      {glyph === 'check' && (
        <Icon name="check" size={11} color={fg} strokeWidth={3} />
      )}
      {glyph === 'spark' && <Icon name="sparkle" size={11} color={fg} active />}
      <Text style={[styles.chipText, { color: fg }]}>{label}</Text>
    </View>
  );
}

/**
 * 6px coverage micro-bar. A green segment for confidently-available
 * ingredients, an amber segment for unclear ones, and the remaining track
 * (missing) shows the muted track color. Flex-based so no percentage strings.
 */
export function CoverageBar({
  available,
  unclear,
  total,
  colors,
}: {
  available: number;
  unclear: number;
  total: number;
  colors: ThemeColors;
}) {
  const safeTotal = total > 0 ? total : 1;
  const avail = Math.max(0, Math.min(safeTotal, available));
  const unc = Math.max(0, Math.min(safeTotal - avail, unclear));
  const rest = Math.max(0, safeTotal - avail - unc);
  return (
    <View style={[styles.barTrack, { backgroundColor: colors.borderLight }]}>
      {avail > 0 && (
        <View style={{ flex: avail, backgroundColor: colors.success }} />
      )}
      {unc > 0 && (
        <View
          style={{ flex: unc, backgroundColor: colors.warning, opacity: 0.85 }}
        />
      )}
      {rest > 0 && <View style={{ flex: rest }} />}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  chipText: {
    fontSize: 11,
    fontFamily: fontFamilies.bold,
    letterSpacing: 0.1,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  barTrack: {
    height: 6,
    borderRadius: 999,
    flexDirection: 'row',
    overflow: 'hidden',
  },
});
