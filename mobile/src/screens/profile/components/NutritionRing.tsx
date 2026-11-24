import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { fontFamilies } from '../../../theme';
import type { ThemeColors } from '../../../theme';

interface Props {
  /** 0–1 progress, clamped by the caller (progressFraction). */
  progress: number;
  size: number;
  strokeWidth: number;
  color: string;
  trackColor: string;
  centerValue: string;
  centerLabel: string;
  subLabel?: string;
  colors: ThemeColors;
}

/**
 * Simple circular progress ring (react-native-svg). Used for the big protein
 * ring on the tracking dashboard. Pure presentation — no animation to keep it
 * light and avoid a new dependency.
 */
export function NutritionRing({
  progress,
  size,
  strokeWidth,
  color,
  trackColor,
  centerValue,
  centerLabel,
  subLabel,
  colors,
}: Props) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(1, Math.max(0, progress));
  const dashOffset = circumference * (1 - clamped);

  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={trackColor}
          strokeWidth={strokeWidth}
          fill="none"
        />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={color}
          strokeWidth={strokeWidth}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={dashOffset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <View style={styles.center}>
        <Text style={[styles.value, { color: colors.text }]}>{centerValue}</Text>
        <Text style={[styles.label, { color: colors.textSecondary }]}>{centerLabel}</Text>
        {subLabel ? (
          <Text style={[styles.sub, { color: colors.textTertiary }]}>{subLabel}</Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  value: { fontFamily: fontFamilies.displayBold, fontSize: 38, lineHeight: 40, letterSpacing: -1 },
  label: {
    fontFamily: fontFamilies.semibold,
    fontSize: 11,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    marginTop: 2,
  },
  sub: { fontFamily: fontFamilies.medium, fontSize: 11.5, marginTop: 2 },
});
