import React from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { fontFamilies } from '../../theme';
import { Icon, IconName } from '../common/Icon';
import { useDealsTheme } from './dealsTheme';

/** Filter ids unify the curated "smart" filters with the product categories. */
export type DealFilter =
  | 'all'
  | 'top'
  | 'forYou'
  | 'trend'
  | 'fruits_vegetables'
  | 'meat_fish'
  | 'dairy'
  | 'bakery'
  | 'drinks'
  | 'snacks_sweets'
  | 'pantry'
  | 'ready_meals'
  | 'frozen'
  | 'other';

interface FilterDef {
  id: DealFilter;
  labelKey: string;
  icon?: IconName;
  /** Pro-only filters render with a lock + reduced opacity (Free tier). */
  pro?: boolean;
}

// Every chip carries an icon so the strip reads as labelled chips, not bare
// dots. Icons are picked from the existing IconName set; where no exact match
// exists we use the closest sensible fallback ('tag' = generic offer).
const FILTERS: FilterDef[] = [
  { id: 'all', labelKey: 'deals.filters.all', icon: 'tag' },
  { id: 'top', labelKey: 'deals.filters.top', icon: 'flash' },
  { id: 'forYou', labelKey: 'deals.filters.forYou', icon: 'sparkle' },
  { id: 'trend', labelKey: 'deals.filters.trend', icon: 'trend-up' },
  { id: 'fruits_vegetables', labelKey: 'deals.categories.fruits_vegetables', icon: 'leaf' },
  { id: 'meat_fish', labelKey: 'deals.categories.meat_fish', icon: 'flame' },
  // Das Vorrats-Icon gehoert jetzt zur Vorrats-Kategorie; Milchprodukte
  // bekommen den Becher-nahen 'plan'-Marker als naechstbeste Entsprechung.
  { id: 'dairy', labelKey: 'deals.categories.dairy', icon: 'plan' },
  { id: 'bakery', labelKey: 'deals.categories.bakery', icon: 'cheffity-hat' },
  { id: 'drinks', labelKey: 'deals.categories.drinks', icon: 'cart' },
  { id: 'snacks_sweets', labelKey: 'deals.categories.snacks_sweets', icon: 'star' },
  { id: 'pantry', labelKey: 'deals.categories.pantry', icon: 'pantry' },
  { id: 'ready_meals', labelKey: 'deals.categories.ready_meals', icon: 'clock' },
  // Kein Schnee-/Eis-Icon im Satz vorhanden; 'droplet' ist die naechstbeste
  // Entsprechung (gefrorenes Wasser) und war vorher mit 'pantry' doppelt belegt.
  { id: 'frozen', labelKey: 'deals.categories.frozen', icon: 'droplet' },
  { id: 'other', labelKey: 'deals.categories.other', icon: 'tag' },
];

interface Props {
  active: DealFilter;
  onChange: (filter: DealFilter) => void;
  /** Per-filter result counts (optional badge). */
  counts?: Partial<Record<DealFilter, number>>;
}

export function CategoryStrip({ active, onChange, counts }: Props) {
  return (
    <FlatList
      horizontal
      showsHorizontalScrollIndicator={false}
      data={FILTERS}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.list}
      renderItem={({ item }) => (
        <CategoryChip
          def={item}
          active={item.id === active}
          count={counts?.[item.id]}
          onPress={() => onChange(item.id)}
        />
      )}
    />
  );
}

function CategoryChip({
  def,
  active,
  count,
  onPress,
}: {
  def: FilterDef;
  active: boolean;
  count?: number;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const { colors, dark, chipFill, chipActiveBg, chipActiveFg } = useDealsTheme();

  const bg = active ? chipActiveBg : chipFill;
  const fg = active ? chipActiveFg : colors.text;
  const border = active ? bg : dark ? '#2A2A2A' : '#E5E7EB';
  const label = t(def.labelKey);

  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, { backgroundColor: bg, borderColor: border }]}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={count != null ? `${label} (${count})` : label}
    >
      {def.icon && <Icon name={def.icon} size={13} color={fg} active={active} />}
      <Text style={[styles.chipText, { color: fg }]} numberOfLines={1}>{label}</Text>
      {count != null && (
        <View
          style={[
            styles.countWrap,
            {
              backgroundColor: active
                ? dark
                  ? 'rgba(0,0,0,0.12)'
                  : 'rgba(255,255,255,0.2)'
                : dark
                  ? '#2A2A2A'
                  : '#E5E7EB',
            },
          ]}
        >
          <Text style={[styles.countText, { color: fg }]}>{count}</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 10, gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipText: { fontSize: 13, fontFamily: fontFamilies.semibold, letterSpacing: -0.1 },
  countWrap: { minWidth: 18, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 8, alignItems: 'center' },
  countText: { fontSize: 11, fontFamily: fontFamilies.bold },
});
