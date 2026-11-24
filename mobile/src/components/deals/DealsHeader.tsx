import React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { fontFamilies } from '../../theme';
import { Icon } from '../common/Icon';
import { HeaderActions } from '../common/HeaderActions';
import { useDealsTheme } from './dealsTheme';

interface HeaderBarProps {
  /** Resolved location label, e.g. "10115 Berlin · 40 km". Null → "add location". */
  locationLabel?: string | null;
  onPressLocation?: () => void;
}

/**
 * Fixed top bar: location eyebrow + title + HeaderActions (cart/pantry/profile).
 * Stays pinned while the search + filter row (DealsSearchBar) scrolls away with
 * the feed.
 */
export function DealsHeaderBar({ locationLabel, onPressLocation }: HeaderBarProps) {
  const { t } = useTranslation();
  const { colors } = useDealsTheme();

  return (
    <View style={styles.header}>
      <View style={styles.titleWrap}>
        <Pressable onPress={onPressLocation} hitSlop={6} style={styles.eyebrow}>
          <Icon name="pin" size={11} color={colors.textTertiary} />
          <Text style={[styles.eyebrowText, { color: colors.textTertiary }]} numberOfLines={1}>
            {locationLabel ?? t('deals.addLocation')}
          </Text>
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>{t('deals.title')}</Text>
      </View>
      <HeaderActions />
    </View>
  );
}

interface SearchBarProps {
  searchQuery?: string;
  onSearchChange?: (value: string) => void;
  onPressFilters?: () => void;
}

/**
 * Search field + filter button. Lives INSIDE the scrollable feed header so it
 * scrolls away on scroll-down and reappears at the top — only the title bar is
 * pinned. Search filters locally; it never triggers a backend fetch.
 */
export function DealsSearchBar({ searchQuery = '', onSearchChange, onPressFilters }: SearchBarProps) {
  const { t } = useTranslation();
  const { colors, chipFill } = useDealsTheme();
  const hasSearch = searchQuery.trim().length > 0;

  return (
    <View style={styles.searchRow}>
      <View style={[styles.searchField, { backgroundColor: chipFill }]}>
        <Icon name="search" size={16} color={colors.textTertiary} />
        <TextInput
          value={searchQuery}
          onChangeText={onSearchChange}
          placeholder={t('deals.searchPlaceholder')}
          placeholderTextColor={colors.textTertiary}
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
          accessibilityLabel={t('deals.searchPlaceholder')}
          style={[styles.searchInput, { color: colors.text }]}
        />
        {hasSearch && (
          <Pressable
            onPress={() => onSearchChange?.('')}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('common.cancel')}
          >
            <Icon name="close" size={16} color={colors.textTertiary} />
          </Pressable>
        )}
      </View>
      <Pressable
        onPress={onPressFilters}
        style={[styles.filterBtn, { backgroundColor: chipFill }]}
        accessibilityRole="button"
        accessibilityLabel={t('deals.filtersA11y')}
      >
        <Icon name="sliders" size={18} color={colors.text} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingLeft: 20,
    paddingRight: 14,
    paddingTop: 6,
    paddingBottom: 6,
  },
  titleWrap: { flexShrink: 1 },
  eyebrow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  eyebrowText: { fontSize: 11, fontFamily: fontFamilies.semibold, letterSpacing: 0.5, textTransform: 'uppercase' },
  title: { fontFamily: fontFamilies.displaySemibold, fontSize: 30, letterSpacing: -0.6, marginTop: 4, lineHeight: 32 },
  searchRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 },
  searchField: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12 },
  searchInput: { flex: 1, minWidth: 0, padding: 0, fontSize: 14, fontFamily: fontFamilies.medium },
  filterBtn: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
});
