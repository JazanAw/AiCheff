import React from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { fontFamilies } from '../../theme';
import { Icon } from '../common/Icon';
import { StoreFilterOption } from '../../utils/storeBrand';
import { STORES, useDealsTheme } from './dealsTheme';

interface Props {
  /** Brands that actually have deals in the current (search/category) base. */
  options: StoreFilterOption[];
  /** Selected brand key, or null for "Alle Läden". */
  active: string | null;
  onChange: (key: string | null) => void;
}

/**
 * Horizontal store/supermarket filter strip shown under the search bar. Lives
 * inside the scrollable feed header (NOT sticky) so it scrolls away with the
 * content, just like the search field + category strip above it.
 *
 * Visually lighter + smaller than the category chips: a compact monogram dot in
 * the chain's brand colour, smaller text, a thin pill — so it reads clearly as a
 * secondary, different filter row rather than a second category bar.
 */
export function StoreStrip({ options, active, onChange }: Props) {
  const { t } = useTranslation();

  // Nothing to filter by (≤1 brand) → don't add visual noise.
  if (options.length < 2) return null;

  const rows: ({ key: null; label: string; count?: number } | StoreFilterOption)[] = [
    { key: null, label: t('deals.stores.all') },
    ...options,
  ];

  return (
    <FlatList
      horizontal
      showsHorizontalScrollIndicator={false}
      data={rows}
      keyExtractor={(item) => item.key ?? '__all__'}
      contentContainerStyle={styles.list}
      renderItem={({ item }) => (
        <StoreChip
          label={item.label}
          count={'count' in item ? item.count : undefined}
          brandKey={item.key}
          active={item.key === active}
          onPress={() => onChange(item.key)}
        />
      )}
    />
  );
}

function brandTint(brandKey: string | null): string | null {
  if (!brandKey) return null;
  const meta = STORES[brandKey.toUpperCase()];
  return meta?.tint ?? null;
}

function StoreChip({
  label,
  count,
  brandKey,
  active,
  onPress,
}: {
  label: string;
  count?: number;
  brandKey: string | null;
  active: boolean;
  onPress: () => void;
}) {
  const { colors, dark, chipFill } = useDealsTheme();
  const tint = brandTint(brandKey);

  const bg = active ? (dark ? '#2A2A2A' : '#1A1A1A') : chipFill;
  const fg = active ? '#FFFFFF' : colors.textSecondary;
  const border = active ? bg : dark ? '#262626' : '#E5E7EB';
  const dotColor = tint ?? (active ? '#FFFFFF' : colors.textTertiary);

  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, { backgroundColor: bg, borderColor: border }]}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={count != null ? `${label} (${count})` : label}
    >
      {brandKey ? (
        <View style={[styles.dot, { backgroundColor: dotColor }]} />
      ) : (
        <Icon name="pin" size={11} color={fg} />
      )}
      <Text style={[styles.chipText, { color: fg }]} numberOfLines={1}>
        {label}
      </Text>
      {count != null && (
        <Text style={[styles.count, { color: active ? 'rgba(255,255,255,0.7)' : colors.textTertiary }]}>
          {count}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Tighter than CategoryStrip (paddingTop 8 / chip py 8) so the two rows read
  // as a primary + secondary pair, not two equal bars.
  list: { paddingHorizontal: 20, paddingTop: 2, paddingBottom: 8, gap: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  chipText: { fontSize: 12, fontFamily: fontFamilies.semibold, letterSpacing: -0.1 },
  count: { fontSize: 11, fontFamily: fontFamilies.bold },
});
