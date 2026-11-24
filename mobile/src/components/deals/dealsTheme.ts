import { useColorScheme } from 'react-native';
import { useThemeColors } from '../../theme';
import type { ThemeColors } from '../../theme';

/**
 * Deal-screen accents that sit alongside the base theme tokens. The redesign
 * introduces a secondary teal CTA color and a small set of tinted "pill" tones
 * (trend / locked / primary) that aren't part of the global palette.
 *
 * Everything else (bg, surface, text, border, primary…) comes straight from
 * mobile/src/theme/colors.ts so light + dark stay in sync.
 */
export const ACTION_TEAL = '#2EB6C9';

export type PillTone = 'default' | 'primary' | 'trend' | 'locked';

export interface DealsTheme {
  colors: ThemeColors;
  dark: boolean;
  accent: string;
  /** Neutral chip / search-field fill (between surface and surfaceElevated). */
  chipFill: string;
  /** Active (inverted) chip background + foreground. */
  chipActiveBg: string;
  chipActiveFg: string;
  pill: Record<PillTone, { bg: string; fg: string; border: string }>;
  /** Locked / Pro accent (purple) used for nutrition gates. */
  locked: { fg: string; bg: string; border: string; button: string };
}

export function useDealsTheme(): DealsTheme {
  const colors = useThemeColors();
  const dark = useColorScheme() === 'dark';

  return {
    colors,
    dark,
    accent: ACTION_TEAL,
    chipFill: dark ? '#1D1D1D' : '#F2F4F7',
    chipActiveBg: dark ? '#FFFFFF' : '#1A1A1A',
    chipActiveFg: dark ? '#1A1A1A' : '#FFFFFF',
    pill: {
      default: {
        bg: dark ? '#1D1D1D' : '#F2F4F7',
        fg: colors.textSecondary,
        border: dark ? '#262626' : '#E5E7EB',
      },
      primary: {
        bg: dark ? '#2A1A10' : '#FFE4D5',
        fg: colors.primary,
        border: dark ? '#3A1D10' : '#FFD0B5',
      },
      trend: {
        bg: dark ? '#10241D' : '#D8F4EA',
        fg: dark ? '#2EE0A6' : '#0F8A5C',
        border: dark ? '#163A30' : '#A8E0CD',
      },
      locked: {
        bg: dark ? '#1F1A26' : '#EDE9F6',
        fg: dark ? '#B49EE2' : '#6B4FB8',
        border: dark ? '#2A2236' : '#D6CCEE',
      },
    },
    locked: {
      fg: dark ? '#B49EE2' : '#6B4FB8',
      bg: dark ? '#1F1A26' : '#F3EFFA',
      border: dark ? '#2A2236' : '#D6CCEE',
      button: dark ? '#B49EE2' : '#6B4FB8',
    },
  };
}

/** Neutral store monogram palette — text labels only, no real logos (brief). */
export const STORES: Record<string, { tint: string; short: string; fg?: string }> = {
  REWE: { tint: '#E30613', short: 'R' },
  LIDL: { tint: '#0050AA', short: 'L' },
  ALDI: { tint: '#00549F', short: 'A' },
  EDEKA: { tint: '#FFCC00', short: 'E', fg: '#1A1A1A' },
  PENNY: { tint: '#CC071E', short: 'P' },
  KAUFLAND: { tint: '#E10915', short: 'K' },
};

export function storeMeta(name: string, fallbackTint: string) {
  const key = name?.toUpperCase().trim();
  return STORES[key] ?? { tint: fallbackTint, short: (name || '?').charAt(0).toUpperCase() };
}

/** Format a EUR price the German way: 2.49 -> "2,49 €". */
export function formatEuro(value: number, withSpace = true): string {
  return `${value.toFixed(2).replace('.', ',')}${withSpace ? ' ' : ''}€`;
}

const WEEKDAYS_DE = ['So.', 'Mo.', 'Di.', 'Mi.', 'Do.', 'Fr.', 'Sa.'];

/** ISO date -> short German "Sa., 24.05." Returns null on unparseable input. */
export function formatShortDate(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${WEEKDAYS_DE[d.getDay()]}, ${day}.${month}.`;
}
