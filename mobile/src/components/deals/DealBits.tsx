import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { fontFamilies } from '../../theme';
import { Icon, IconName } from '../common/Icon';
import { PillTone, storeMeta, useDealsTheme } from './dealsTheme';

// ── Store monogram + label ──────────────────────────────────────────
export function StoreTag({ name }: { name: string }) {
  const { colors } = useDealsTheme();
  const s = storeMeta(name, colors.textTertiary);
  return (
    <View style={styles.storeRow}>
      <View style={[styles.storeTile, { backgroundColor: s.tint }]}>
        <Text style={[styles.storeShort, { color: s.fg ?? '#fff' }]}>{s.short}</Text>
      </View>
      <Text style={[styles.storeName, { color: colors.text }]} numberOfLines={1}>
        {name}
      </Text>
    </View>
  );
}

// ── Discount badge ──────────────────────────────────────────────────
export function DiscountBadge({ value, variant = 'default' }: { value: number; variant?: 'default' | 'top' }) {
  const { colors, dark } = useDealsTheme();
  if (variant === 'top') {
    return (
      <View style={[styles.badgeBase, { backgroundColor: colors.primary }]}>
        <Text style={[styles.badgeText, { color: '#fff' }]}>−{value}%</Text>
      </View>
    );
  }
  return (
    <View
      style={[
        styles.badgeBase,
        {
          backgroundColor: dark ? '#3A1D10' : '#FFE4D5',
          borderWidth: 1,
          borderColor: `${colors.primary}33`,
        },
      ]}
    >
      <Text style={[styles.badgeText, { color: colors.primary }]}>−{value}%</Text>
    </View>
  );
}

// ── Favorite heart toggle ───────────────────────────────────────────
export function FavoriteButton({
  active,
  onPress,
}: {
  active?: boolean;
  onPress?: () => void;
}) {
  const { colors, dark } = useDealsTheme();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel="Favorit"
      style={[styles.heart, { backgroundColor: dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }]}
    >
      <Icon name="heart" size={18} color={active ? colors.primary : colors.textSecondary} active={active} />
    </Pressable>
  );
}

// ── Pill (validity / trend / kcal / lock) ───────────────────────────
export function Pill({
  children,
  icon,
  tone = 'default',
}: {
  children: React.ReactNode;
  icon?: IconName;
  tone?: PillTone;
}) {
  const { pill } = useDealsTheme();
  const t = pill[tone];
  return (
    <View style={[styles.pill, { backgroundColor: t.bg, borderColor: t.border }]}>
      {icon && <Icon name={icon} size={11} color={t.fg} active={tone !== 'default'} />}
      <Text style={[styles.pillText, { color: t.fg }]} numberOfLines={1}>
        {children}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  storeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  storeTile: {
    width: 18,
    height: 18,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  storeShort: { fontSize: 10.5, fontFamily: fontFamilies.extrabold, lineHeight: 13 },
  storeName: { fontSize: 12, fontFamily: fontFamilies.bold, letterSpacing: 0.2, flexShrink: 1 },
  badgeBase: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  badgeText: { fontSize: 12, fontFamily: fontFamilies.extrabold, letterSpacing: -0.2 },
  heart: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
  },
  pillText: { fontSize: 11, fontFamily: fontFamilies.semibold, lineHeight: 14, flexShrink: 1 },
});
