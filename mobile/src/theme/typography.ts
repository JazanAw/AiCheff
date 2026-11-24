import { TextStyle } from 'react-native';

const FONT_REGULAR = 'PlusJakartaSans_400Regular';
const FONT_MEDIUM = 'PlusJakartaSans_500Medium';
const FONT_SEMIBOLD = 'PlusJakartaSans_600SemiBold';
const FONT_BOLD = 'PlusJakartaSans_700Bold';
const FONT_EXTRABOLD = 'PlusJakartaSans_800ExtraBold';

const DISPLAY_SEMIBOLD = 'Fraunces_600SemiBold';
const DISPLAY_BOLD = 'Fraunces_700Bold';

export const fontFamilies = {
  regular: FONT_REGULAR,
  medium: FONT_MEDIUM,
  semibold: FONT_SEMIBOLD,
  bold: FONT_BOLD,
  extrabold: FONT_EXTRABOLD,
  displaySemibold: DISPLAY_SEMIBOLD,
  displayBold: DISPLAY_BOLD,
} as const;

export const typography = {
  display: {
    fontFamily: DISPLAY_SEMIBOLD,
    fontSize: 32,
    lineHeight: 36,
    letterSpacing: -0.5,
  } as TextStyle,
  displayLarge: {
    fontFamily: DISPLAY_SEMIBOLD,
    fontSize: 34,
    lineHeight: 36,
    letterSpacing: -0.6,
  } as TextStyle,
  h1: {
    fontFamily: DISPLAY_SEMIBOLD,
    fontSize: 28,
    lineHeight: 32,
    letterSpacing: -0.5,
  } as TextStyle,
  h2: {
    fontFamily: FONT_BOLD,
    fontSize: 22,
    lineHeight: 28,
    letterSpacing: -0.3,
  } as TextStyle,
  h3: {
    fontFamily: FONT_SEMIBOLD,
    fontSize: 18,
    lineHeight: 24,
  } as TextStyle,
  body: {
    fontFamily: FONT_REGULAR,
    fontSize: 16,
    lineHeight: 24,
  } as TextStyle,
  bodySmall: {
    fontFamily: FONT_REGULAR,
    fontSize: 14,
    lineHeight: 20,
  } as TextStyle,
  caption: {
    fontFamily: FONT_REGULAR,
    fontSize: 12,
    lineHeight: 16,
  } as TextStyle,
  button: {
    fontFamily: FONT_SEMIBOLD,
    fontSize: 16,
    lineHeight: 24,
  } as TextStyle,
  buttonSmall: {
    fontFamily: FONT_SEMIBOLD,
    fontSize: 14,
    lineHeight: 20,
  } as TextStyle,
  label: {
    fontFamily: FONT_SEMIBOLD,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  } as TextStyle,
  tabLabel: {
    fontFamily: FONT_MEDIUM,
    fontSize: 10.5,
    lineHeight: 14,
    letterSpacing: 0.1,
  } as TextStyle,
} as const;
