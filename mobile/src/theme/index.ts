import { useColorScheme } from 'react-native';
import { colors, ThemeColors } from './colors';
import { typography, fontFamilies } from './typography';
import { spacing, radius } from './spacing';

export { colors, typography, fontFamilies, spacing, radius };
export type { ThemeColors };

export function useThemeColors(): ThemeColors {
  const scheme = useColorScheme();
  return scheme === 'dark' ? colors.dark : colors.light;
}
