import React, { useMemo, useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Reanimated from 'react-native-reanimated';
import { useSwipeToDismiss } from '../../../components/common/useSwipeToDismiss';
import { fontFamilies, radius, spacing, typography } from '../../../theme';
import type { ThemeColors } from '../../../theme';
import { Icon } from '../../../components/common/Icon';
import { RecipeIllustration } from '../../../components/common/RecipeIllustration';
import {
  CUISINE_FILTER_CANDIDATES,
  getCuisineLabel,
  normalizeCuisine,
} from '../../../utils/cuisine';
import type { CuisineSlug } from '../../../utils/cuisine';
import type { Recipe } from '../../../types';

interface Props {
  visible: boolean;
  recipes: Recipe[];
  loading: boolean;
  colors: ThemeColors;
  t: (k: string, opts?: Record<string, unknown>) => string;
  onClose: () => void;
  onSelect: (recipe: Recipe) => void;
}

/**
 * Recipe picker shown when an empty planner slot is tapped. Search + optional
 * cuisine chips + compact rows. Selecting a recipe hands it back so the planner
 * can open the existing PlanRecipeSheet with the slot preselected.
 */
export function RecipePickerSheet({
  visible,
  recipes,
  loading,
  colors,
  t,
  onClose,
  onSelect,
}: Props) {
  const insets = useSafeAreaInsets();
  const { gesture, sheetStyle, scrollHandler, scrollRef } = useSwipeToDismiss({
    visible,
    onDismiss: onClose,
  });
  const [query, setQuery] = useState('');
  const [cuisine, setCuisine] = useState<CuisineSlug | 'all'>('all');

  // Cuisine chips: only the curated candidates that actually occur in the
  // loaded recipes — no dead chips. 'all' is always present.
  const cuisineOptions = useMemo(() => {
    const present = new Set(recipes.map((r) => normalizeCuisine(r.cuisine)));
    return CUISINE_FILTER_CANDIDATES.filter((slug) => present.has(slug));
  }, [recipes]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return recipes.filter((r) => {
      if (cuisine !== 'all' && normalizeCuisine(r.cuisine) !== cuisine) return false;
      if (q && !r.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [recipes, query, cuisine]);

  const renderItem = ({ item }: { item: Recipe }) => {
    const kcal = item.nutritionPerServing?.calories;
    return (
      <Pressable
        style={({ pressed }) => [
          styles.row,
          { backgroundColor: colors.surfaceElevated, borderColor: colors.border, opacity: pressed ? 0.85 : 1 },
        ]}
        onPress={() => onSelect(item)}
        accessibilityRole="button"
        accessibilityLabel={item.name}
      >
        <View style={styles.thumb}>
          <RecipeIllustration recipeId={item.id} />
        </View>
        <View style={styles.rowBody}>
          <Text style={[styles.rowName, { color: colors.text }]} numberOfLines={1}>
            {item.name}
          </Text>
          <View style={styles.rowMeta}>
            <View style={styles.metaItem}>
              <Icon name="clock" size={11} color={colors.textSecondary} />
              <Text style={[styles.metaText, { color: colors.textSecondary }]}>
                {t('cheffity.cookTime', { minutes: item.cookTimeMinutes })}
              </Text>
            </View>
            {kcal ? (
              <View style={styles.metaItem}>
                <Icon name="flame" size={11} color={colors.textSecondary} />
                <Text style={[styles.metaText, { color: colors.textSecondary }]}>
                  {Math.round(kcal)} kcal
                </Text>
              </View>
            ) : null}
            {item.cuisine ? (
              <Text style={[styles.metaText, { color: colors.textSecondary }]} numberOfLines={1}>
                {getCuisineLabel(normalizeCuisine(item.cuisine), t)}
              </Text>
            ) : null}
          </View>
        </View>
        <Icon name="chevron-right" size={18} color={colors.textTertiary} />
      </Pressable>
    );
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <GestureHandlerRootView style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <GestureDetector gesture={gesture}>
        <Reanimated.View
          style={[
            styles.sheet,
            { backgroundColor: colors.background, paddingBottom: insets.bottom + spacing.md },
            sheetStyle,
          ]}
        >
          <View style={[styles.handleBar, { backgroundColor: colors.border }]} />

          <View style={styles.header}>
            <Text style={[styles.title, { color: colors.text }]}>
              {t('planner.recipePicker.title')}
            </Text>
            <Pressable onPress={onClose} hitSlop={10} style={styles.closeBtn}>
              <Icon name="close" size={20} color={colors.textSecondary} />
            </Pressable>
          </View>

          {/* Search */}
          <View style={[styles.search, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Icon name="search" size={16} color={colors.textTertiary} />
            <TextInput
              style={[styles.searchInput, { color: colors.text }]}
              placeholder={t('planner.recipePicker.searchPlaceholder')}
              placeholderTextColor={colors.textTertiary}
              value={query}
              onChangeText={setQuery}
              autoCorrect={false}
              returnKeyType="search"
            />
            {query.length > 0 ? (
              <Pressable onPress={() => setQuery('')} hitSlop={8}>
                <Icon name="close" size={16} color={colors.textTertiary} />
              </Pressable>
            ) : null}
          </View>

          {/* Cuisine chips */}
          {cuisineOptions.length > 0 && (
            <FlatList
              horizontal
              data={['all', ...cuisineOptions] as Array<CuisineSlug | 'all'>}
              keyExtractor={(slug) => slug}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipRow}
              style={styles.chipList}
              renderItem={({ item: slug }) => {
                const active = slug === cuisine;
                return (
                  <Pressable
                    onPress={() => setCuisine(slug)}
                    style={[
                      styles.chip,
                      {
                        backgroundColor: active ? colors.primary : colors.surface,
                        borderColor: active ? colors.primary : colors.border,
                      },
                    ]}
                  >
                    <Text
                      style={[styles.chipText, { color: active ? '#FFFFFF' : colors.text }]}
                    >
                      {slug === 'all'
                        ? t('planner.recipePicker.all')
                        : getCuisineLabel(slug, t)}
                    </Text>
                  </Pressable>
                );
              }}
            />
          )}

          {loading ? (
            <View style={styles.placeholder}>
              <Text style={[typography.body, { color: colors.textSecondary }]}>
                {t('common.loading')}
              </Text>
            </View>
          ) : filtered.length === 0 ? (
            <View style={styles.placeholder}>
              <Text style={[typography.body, { color: colors.textSecondary }]}>
                {t('planner.recipePicker.empty')}
              </Text>
            </View>
          ) : (
            <Reanimated.FlatList
              ref={scrollRef}
              onScroll={scrollHandler}
              scrollEventThrottle={16}
              data={filtered}
              keyExtractor={(r) => r.id}
              renderItem={renderItem}
              keyboardShouldPersistTaps="handled"
              ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
              contentContainerStyle={styles.listContent}
              showsVerticalScrollIndicator={false}
            />
          )}
        </Reanimated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: {
    maxHeight: '88%',
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  handleBar: {
    width: 40,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: spacing.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  title: { ...typography.h3 },
  closeBtn: { padding: 4 },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    height: 44,
  },
  searchInput: { flex: 1, fontFamily: fontFamilies.regular, fontSize: 15, padding: 0 },
  chipList: { flexGrow: 0, marginTop: spacing.sm },
  chipRow: { gap: 8, paddingVertical: 2, paddingRight: spacing.md },
  chip: {
    paddingVertical: 7,
    paddingHorizontal: 13,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipText: { fontSize: 12.5, fontFamily: fontFamilies.semibold },
  listContent: { paddingTop: spacing.md, paddingBottom: spacing.lg },
  placeholder: { paddingVertical: spacing.xxl, alignItems: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 14,
    borderWidth: 1,
    padding: 10,
    minHeight: 64,
  },
  thumb: {
    width: 48,
    height: 48,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#0002',
  },
  rowBody: { flex: 1, minWidth: 0 },
  rowName: {
    fontFamily: fontFamilies.displaySemibold,
    fontSize: 15,
    letterSpacing: -0.2,
  },
  rowMeta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginTop: 4 },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  metaText: { fontFamily: fontFamilies.regular, fontSize: 11.5 },
});
