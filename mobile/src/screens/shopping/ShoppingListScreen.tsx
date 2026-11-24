import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { useThemeColors, typography, fontFamilies, spacing, radius } from '../../theme';
import type { ThemeColors } from '../../theme';
import { useSubscription } from '../../store/SubscriptionContext';
import { Icon } from '../../components/common/Icon';
import type { PantryItem, ShoppingListItem } from '../../types';
import {
  addShoppingItem,
  checkOffAndMoveToPantry,
  clearCheckedShoppingItems,
  deleteShoppingItem,
  fetchShoppingList,
  uncheckShoppingItem,
} from '../../services/shoppingListApi';
import {
  addPantryItem,
  deletePantryItem,
  fetchPantryItems,
  markPantryItemConsumed,
  unmarkPantryItemConsumed,
} from '../../services/pantryApi';
import { ScanPantryItemScreen } from './ScanPantryItemScreen';
import { ConfirmPantryItemSheet } from './ConfirmPantryItemSheet';

type ActiveTab = 'list' | 'pantry';

/**
 * Confirm-sheet target. `barcode: null` = pure manual entry (no OFF lookup).
 * `null` whole value = sheet hidden.
 */
type ConfirmContext = { barcode: string | null } | null;

export function ShoppingListScreen() {
  const { t, i18n } = useTranslation();
  const colors = useThemeColors();
  const navigation = useNavigation();
  const { hasFeature } = useSubscription();

  const [tab, setTab] = useState<ActiveTab>('list');
  const [shopping, setShopping] = useState<ShoppingListItem[]>([]);
  const [pantry, setPantry] = useState<PantryItem[]>([]);
  const [showConsumed, setShowConsumed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newQuantity, setNewQuantity] = useState('1');
  const [newUnit, setNewUnit] = useState('');
  const [scannerVisible, setScannerVisible] = useState(false);
  const [confirmContext, setConfirmContext] = useState<ConfirmContext>(null);
  const [savedToast, setSavedToast] = useState(false);

  const loadAll = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([
        fetchShoppingList(),
        fetchPantryItems({ includeConsumed: showConsumed }),
      ]);
      setShopping(s);
      setPantry(p);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [showConsumed]);

  useEffect(() => {
    setLoading(true);
    loadAll().finally(() => setLoading(false));
  }, [loadAll]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadAll();
    setRefreshing(false);
  };

  const handleToggle = async (item: ShoppingListItem) => {
    if (item.checked) {
      // Uncheck: keep pantry items as-is (user can manually consume them)
      const previous = item;
      setShopping((prev) => prev.map((i) => (i.id === item.id ? { ...i, checked: false, purchasedAt: undefined } : i)));
      try {
        await uncheckShoppingItem(item.id);
      } catch (e) {
        setShopping((prev) => prev.map((i) => (i.id === item.id ? previous : i)));
        Alert.alert(t('common.error'), (e as Error).message);
      }
      return;
    }
    // Optimistically mark checked + move to pantry
    setShopping((prev) =>
      prev.map((i) => (i.id === item.id ? { ...i, checked: true, purchasedAt: new Date().toISOString() } : i)),
    );
    try {
      const { updatedShopping } = await checkOffAndMoveToPantry(item);
      setShopping((prev) => prev.map((i) => (i.id === item.id ? updatedShopping : i)));
      await loadAll();
    } catch (e) {
      setShopping((prev) => prev.map((i) => (i.id === item.id ? { ...i, checked: false } : i)));
      Alert.alert(t('common.error'), (e as Error).message);
    }
  };

  const handleRemoveShopping = (item: ShoppingListItem) => {
    Alert.alert(t('common.delete'), item.name, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: async () => {
          setShopping((prev) => prev.filter((i) => i.id !== item.id));
          try {
            await deleteShoppingItem(item.id);
          } catch (e) {
            Alert.alert(t('common.error'), (e as Error).message);
            await loadAll();
          }
        },
      },
    ]);
  };

  const handleClearChecked = async () => {
    const previous = shopping;
    setShopping((prev) => prev.filter((i) => !i.checked));
    try {
      await clearCheckedShoppingItems();
    } catch (e) {
      setShopping(previous);
      Alert.alert(t('common.error'), (e as Error).message);
    }
  };

  const handleAddItem = async () => {
    if (!newName.trim()) return;
    const name = newName.trim();
    const quantity = Number(newQuantity) || 1;
    const unit = newUnit.trim();
    setShowAdd(false);
    setNewName('');
    setNewQuantity('1');
    setNewUnit('');
    try {
      if (tab === 'list') {
        const created = await addShoppingItem({ name, quantity, unit });
        setShopping((prev) => [created, ...prev]);
      } else {
        const created = await addPantryItem({ name, quantity, unit });
        setPantry((prev) => [created, ...prev]);
      }
    } catch (e) {
      Alert.alert(t('common.error'), (e as Error).message);
    }
  };

  const handleConsume = async (item: PantryItem) => {
    setPantry((prev) =>
      prev.map((i) => (i.id === item.id ? { ...i, consumedAt: new Date().toISOString() } : i)),
    );
    try {
      const updated = await markPantryItemConsumed(item.id);
      setPantry((prev) => prev.map((i) => (i.id === item.id ? updated : i)));
      if (!showConsumed) {
        setPantry((prev) => prev.filter((i) => i.id !== item.id));
      }
    } catch (e) {
      Alert.alert(t('common.error'), (e as Error).message);
      await loadAll();
    }
  };

  const handleUnconsume = async (item: PantryItem) => {
    try {
      const updated = await unmarkPantryItemConsumed(item.id);
      setPantry((prev) => prev.map((i) => (i.id === item.id ? updated : i)));
    } catch (e) {
      Alert.alert(t('common.error'), (e as Error).message);
    }
  };

  const handleScanPressed = () => {
    setScannerVisible(true);
  };

  const handleScannerBarcode = (barcode: string) => {
    setScannerVisible(false);
    setConfirmContext({ barcode });
  };

  const handleScannerManualEntry = () => {
    setScannerVisible(false);
    setConfirmContext({ barcode: null });
  };

  const handleConfirmSaved = async () => {
    setConfirmContext(null);
    setSavedToast(true);
    setTimeout(() => setSavedToast(false), 2200);
    try {
      const updated = await fetchPantryItems({ includeConsumed: showConsumed });
      setPantry(updated);
      if (tab !== 'pantry') setTab('pantry');
    } catch (e) {
      Alert.alert(t('common.error'), (e as Error).message);
    }
  };

  const handleRemovePantry = (item: PantryItem) => {
    Alert.alert(t('common.delete'), item.name, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: async () => {
          setPantry((prev) => prev.filter((i) => i.id !== item.id));
          try {
            await deletePantryItem(item.id);
          } catch (e) {
            Alert.alert(t('common.error'), (e as Error).message);
            await loadAll();
          }
        },
      },
    ]);
  };

  const totalCost = shopping
    .filter((item) => !item.checked && item.price != null)
    .reduce((sum, item) => sum + (item.price ?? 0) * item.quantity, 0);
  const totalItems = shopping.length;
  const checkedCount = shopping.filter((i) => i.checked).length;
  const dealCount = shopping.filter((i) => i.dealId != null).length;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
      <View style={styles.header}>
        <Pressable
          onPress={() => navigation.goBack()}
          hitSlop={10}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
        >
          <Icon name="arrow-left" size={24} color={colors.text} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, { color: colors.text }]}>
            {t('header.inventory')}
          </Text>
        </View>
        <View style={styles.headerActions}>
          {tab === 'list' && hasFeature('share_list') && (
            <Pressable onPress={() => {}} style={[styles.headerIconButton, { backgroundColor: colors.surface }]}>
              <Icon name="sparkle" size={18} color={colors.primary} />
            </Pressable>
          )}
        </View>
      </View>

      {tab === 'list' && totalItems > 0 && (
        <View style={styles.statsRow}>
          <View style={[styles.statCard, { backgroundColor: colors.surface }]}>
            <Text style={[styles.statLabel, { color: colors.textTertiary }]}>
              {t('shopping.statDone')}
            </Text>
            <View style={styles.statValueRow}>
              <Text style={[styles.statValue, { color: colors.text }]}>{checkedCount}</Text>
              <Text style={[styles.statValueSlash, { color: colors.textSecondary }]}>
                / {totalItems}
              </Text>
            </View>
            <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
              <View
                style={[
                  styles.progressFill,
                  {
                    backgroundColor: colors.accent,
                    width: `${totalItems > 0 ? (checkedCount / totalItems) * 100 : 0}%`,
                  },
                ]}
              />
            </View>
          </View>
          <View style={[styles.statCard, { backgroundColor: colors.primaryLight, borderColor: colors.primary, borderWidth: 1 }]}>
            <View style={styles.statLabelRow}>
              <Icon name="tag" size={11} color={colors.primary} active />
              <Text style={[styles.statLabelPrimary, { color: colors.primary }]}>
                {t('shopping.statDeals')}
              </Text>
            </View>
            <View style={styles.statValueRow}>
              <Text style={[styles.statValue, { color: colors.primary }]}>
                {dealCount}
              </Text>
            </View>
            <Text style={[styles.statSubtext, { color: colors.primary }]}>
              {t('shopping.statDealsHint')}
            </Text>
          </View>
        </View>
      )}

      <SegmentedTabs
        value={tab}
        onChange={setTab}
        colors={colors}
        labels={{ list: t('shopping.tabList'), pantry: t('shopping.tabPantry') }}
        counts={{
          list: shopping.filter((i) => !i.checked).length,
          pantry: pantry.filter((i) => !i.consumedAt).length,
        }}
      />

      {error && (
        <View style={[styles.errorBar, { backgroundColor: colors.errorLight, borderColor: colors.error }]}>
          <Text style={[typography.bodySmall, { color: colors.error }]}>{error}</Text>
        </View>
      )}

      {tab === 'list' ? (
        <ShoppingListBody
          items={shopping}
          loading={loading}
          refreshing={refreshing}
          totalCost={totalCost}
          onRefresh={onRefresh}
          onToggle={handleToggle}
          onRemove={handleRemoveShopping}
          colors={colors}
          t={t}
        />
      ) : (
        <PantryBody
          items={pantry}
          loading={loading}
          refreshing={refreshing}
          showConsumed={showConsumed}
          onRefresh={onRefresh}
          onConsume={handleConsume}
          onUnconsume={handleUnconsume}
          onRemove={handleRemovePantry}
          colors={colors}
          t={t}
        />
      )}

      {showAdd && (
        <View style={[styles.addForm, { backgroundColor: colors.surfaceElevated, borderTopColor: colors.border }]}>
          <TextInput
            style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
            placeholder={t('shopping.itemName')}
            placeholderTextColor={colors.textTertiary}
            value={newName}
            onChangeText={setNewName}
            autoFocus
          />
          <View style={styles.addRow}>
            <TextInput
              style={[styles.input, styles.smallInput, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
              placeholder={t('shopping.quantity')}
              placeholderTextColor={colors.textTertiary}
              value={newQuantity}
              onChangeText={setNewQuantity}
              keyboardType="numeric"
            />
            <TextInput
              style={[styles.input, styles.smallInput, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
              placeholder={t('shopping.unit')}
              placeholderTextColor={colors.textTertiary}
              value={newUnit}
              onChangeText={setNewUnit}
            />
          </View>
          <View style={styles.addRow}>
            <Pressable
              style={[styles.addButton, { backgroundColor: colors.surface, borderColor: colors.border }]}
              onPress={() => { setShowAdd(false); setNewName(''); }}
            >
              <Text style={[typography.button, { color: colors.text }]}>{t('common.cancel')}</Text>
            </Pressable>
            <Pressable
              style={[styles.addButton, { backgroundColor: colors.primary }]}
              onPress={handleAddItem}
            >
              <Text style={[typography.button, { color: '#FFF' }]}>{t('shopping.addItem')}</Text>
            </Pressable>
          </View>
        </View>
      )}

      <View style={[styles.bottomBar, { backgroundColor: colors.surfaceElevated, borderTopColor: colors.border }]}>
        <Pressable
          style={[styles.bottomButton, { backgroundColor: colors.primary }]}
          onPress={() => setShowAdd(true)}
        >
          <Text style={[typography.button, { color: '#FFF' }]}>
            + {tab === 'list' ? t('shopping.addManually') : t('pantry.addManually')}
          </Text>
        </Pressable>
        {tab === 'pantry' && (
          <Pressable
            style={[
              styles.bottomButton,
              styles.bottomButtonSecondary,
              { borderColor: colors.primary },
            ]}
            onPress={handleScanPressed}
          >
            <Text style={[typography.button, { color: colors.primary }]}>
              {t('pantry.scan.scan')}
            </Text>
          </Pressable>
        )}
        {tab === 'list' && shopping.some((i) => i.checked) && (
          <Pressable onPress={handleClearChecked}>
            <Text style={[typography.buttonSmall, { color: colors.error }]}>
              {t('shopping.clearChecked')}
            </Text>
          </Pressable>
        )}
        {tab === 'pantry' && (
          <Pressable onPress={() => setShowConsumed((v) => !v)}>
            <Text style={[typography.buttonSmall, { color: colors.primary }]}>
              {showConsumed ? t('pantry.hideConsumed') : t('pantry.showConsumed')}
            </Text>
          </Pressable>
        )}
      </View>

      {savedToast && (
        <View
          style={[
            styles.savedToast,
            { backgroundColor: colors.accent },
          ]}
          pointerEvents="none"
        >
          <Text style={[typography.bodySmall, { color: '#FFFFFF', textAlign: 'center' }]}>
            {t('pantry.scan.saved')}
          </Text>
        </View>
      )}

      <ScanPantryItemScreen
        visible={scannerVisible}
        onClose={() => setScannerVisible(false)}
        onScanned={handleScannerBarcode}
        onManualEntry={handleScannerManualEntry}
      />
      <ConfirmPantryItemSheet
        visible={confirmContext != null}
        barcode={confirmContext?.barcode ?? null}
        locale={i18n.language}
        onClose={() => setConfirmContext(null)}
        onSaved={handleConfirmSaved}
      />
    </SafeAreaView>
  );
}

function SegmentedTabs({
  value,
  onChange,
  colors,
  labels,
  counts,
}: {
  value: ActiveTab;
  onChange: (v: ActiveTab) => void;
  colors: ThemeColors;
  labels: Record<ActiveTab, string>;
  counts: Record<ActiveTab, number>;
}) {
  return (
    <View style={[styles.segments, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
      {(['list', 'pantry'] as const).map((key) => {
        const active = value === key;
        return (
          <Pressable
            key={key}
            onPress={() => onChange(key)}
            style={[
              styles.segment,
              {
                backgroundColor: active ? colors.surfaceElevated : 'transparent',
                borderColor: active ? colors.primary : 'transparent',
              },
            ]}
          >
            <Text
              style={[
                typography.button,
                { color: active ? colors.primary : colors.textSecondary, fontWeight: active ? '700' : '500' },
              ]}
            >
              {labels[key]}
            </Text>
            {counts[key] > 0 && (
              <Text style={[typography.caption, { color: active ? colors.primary : colors.textTertiary }]}>
                {' '}({counts[key]})
              </Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

function ShoppingListBody({
  items, loading, refreshing, totalCost, onRefresh, onToggle, onRemove, colors, t,
}: {
  items: ShoppingListItem[];
  loading: boolean;
  refreshing: boolean;
  totalCost: number;
  onRefresh: () => void;
  onToggle: (item: ShoppingListItem) => void;
  onRemove: (item: ShoppingListItem) => void;
  colors: ThemeColors;
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  if (loading) {
    return (
      <View style={styles.empty}>
        <Text style={[typography.body, { color: colors.textSecondary }]}>{t('common.loading')}</Text>
      </View>
    );
  }
  if (items.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={[typography.body, { color: colors.textSecondary, textAlign: 'center', paddingHorizontal: spacing.xl }]}>
          {t('shopping.empty')}
        </Text>
      </View>
    );
  }
  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.list}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      renderItem={({ item }) => (
        <Pressable
          style={[styles.itemRow, { borderBottomColor: colors.borderLight }]}
          onPress={() => onToggle(item)}
          onLongPress={() => onRemove(item)}
        >
          <View
            style={[
              styles.checkbox,
              {
                borderColor: item.checked ? colors.primary : colors.border,
                backgroundColor: item.checked ? colors.primary : 'transparent',
              },
            ]}
          >
            {item.checked && <Text style={{ color: '#FFF', fontSize: 12 }}>{'✓'}</Text>}
          </View>
          <View style={styles.itemInfo}>
            <Text
              style={[
                typography.body,
                {
                  color: item.checked ? colors.textTertiary : colors.text,
                  textDecorationLine: item.checked ? 'line-through' : 'none',
                },
              ]}
            >
              {item.quantity > 1 || item.unit ? `${item.quantity}${item.unit ? ` ${item.unit}` : 'x'} ` : ''}
              {item.name}
            </Text>
            {item.storeName && (
              <Text style={[typography.caption, { color: colors.textTertiary }]}>{item.storeName}</Text>
            )}
          </View>
          {item.price != null && (
            <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>
              {(item.price * item.quantity).toFixed(2)} EUR
            </Text>
          )}
        </Pressable>
      )}
      ListFooterComponent={
        totalCost > 0 ? (
          <View style={[styles.totalRow, { borderTopColor: colors.border }]}>
            <Text style={[typography.h3, { color: colors.text }]}>{t('shopping.totalCost')}</Text>
            <Text style={[typography.h3, { color: colors.primary }]}>{totalCost.toFixed(2)} EUR</Text>
          </View>
        ) : null
      }
    />
  );
}

function PantryBody({
  items, loading, refreshing, onRefresh, onConsume, onUnconsume, onRemove, colors, t,
}: {
  items: PantryItem[];
  loading: boolean;
  refreshing: boolean;
  showConsumed: boolean;
  onRefresh: () => void;
  onConsume: (item: PantryItem) => void;
  onUnconsume: (item: PantryItem) => void;
  onRemove: (item: PantryItem) => void;
  colors: ThemeColors;
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  if (loading) {
    return (
      <View style={styles.empty}>
        <Text style={[typography.body, { color: colors.textSecondary }]}>{t('common.loading')}</Text>
      </View>
    );
  }
  if (items.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={[typography.body, { color: colors.textSecondary, textAlign: 'center', paddingHorizontal: spacing.xl }]}>
          {t('pantry.empty')}
        </Text>
      </View>
    );
  }
  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.list}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      renderItem={({ item }) => {
        const consumed = item.consumedAt != null;
        return (
          <Pressable
            style={[styles.itemRow, { borderBottomColor: colors.borderLight }]}
            onPress={() => (consumed ? onUnconsume(item) : onConsume(item))}
            onLongPress={() => onRemove(item)}
          >
            {item.imageUrl ? (
              <Image
                source={{ uri: item.imageUrl }}
                style={[
                  styles.thumbnail,
                  { backgroundColor: colors.surface, opacity: consumed ? 0.5 : 1 },
                ]}
              />
            ) : (
              <View
                style={[
                  styles.checkbox,
                  {
                    borderColor: consumed ? colors.borderLight : colors.accent,
                    backgroundColor: consumed ? colors.borderLight : 'transparent',
                  },
                ]}
              >
                {consumed && <Text style={{ color: colors.textSecondary, fontSize: 12 }}>{'✓'}</Text>}
              </View>
            )}
            <View style={styles.itemInfo}>
              <Text
                style={[
                  typography.body,
                  {
                    color: consumed ? colors.textTertiary : colors.text,
                    textDecorationLine: consumed ? 'line-through' : 'none',
                  },
                ]}
              >
                {item.quantity > 1 || item.unit ? `${item.quantity}${item.unit ? ` ${item.unit}` : 'x'} ` : ''}
                {item.name}
              </Text>
              {item.brand ? (
                <Text style={[typography.caption, { color: colors.textSecondary }]}>
                  {item.brand}
                </Text>
              ) : null}
              <Text style={[typography.caption, { color: colors.textTertiary }]}>
                {item.source === 'shopping_list'
                  ? t('pantry.sourceShopping')
                  : item.source === 'recipe_residual'
                    ? t('pantry.sourceRecipe')
                    : t('pantry.sourceManual')}
                {consumed && item.consumedAt
                  ? ` · ${t('pantry.consumedAt', { date: formatDateShort(item.consumedAt) })}`
                  : ` · ${t('pantry.addedAt', { date: formatDateShort(item.addedAt) })}`}
              </Text>
            </View>
          </Pressable>
        );
      }}
    />
  );
}

function formatDateShort(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
  },
  backButton: {
    width: 32,
    height: 32,
    justifyContent: 'center',
  },
  title: {
    fontFamily: fontFamilies.displaySemibold,
    fontSize: 28,
    lineHeight: 32,
    letterSpacing: -0.5,
  },
  headerActions: { flexDirection: 'row', gap: spacing.sm },
  headerIconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statsRow: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingBottom: spacing.md,
    gap: 10,
  },
  statCard: {
    flex: 1,
    padding: 14,
    borderRadius: 14,
  },
  statLabel: {
    fontFamily: fontFamilies.semibold,
    fontSize: 11,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  statLabelPrimary: {
    fontFamily: fontFamilies.bold,
    fontSize: 11,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  statLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  statValueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4, marginTop: 4 },
  statValue: {
    fontFamily: fontFamilies.displaySemibold,
    fontSize: 22,
  },
  statValueSlash: {
    fontFamily: fontFamilies.regular,
    fontSize: 14,
  },
  statSubtext: {
    fontFamily: fontFamilies.regular,
    fontSize: 11,
    opacity: 0.7,
    marginTop: 6,
  },
  progressTrack: {
    marginTop: 8,
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
  },
  segments: {
    flexDirection: 'row',
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    padding: 3,
  },
  segment: {
    flex: 1,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    borderWidth: 1,
  },
  errorBar: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    gap: spacing.md,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
  },
  itemInfo: { flex: 1 },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.lg,
    borderTopWidth: 1,
    marginTop: spacing.md,
  },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingBottom: spacing.xxl * 2 },
  addForm: { padding: spacing.lg, borderTopWidth: 1, gap: spacing.sm },
  input: {
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    fontSize: 16,
  },
  addRow: { flexDirection: 'row', gap: spacing.sm },
  smallInput: { flex: 1 },
  addButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: radius.md,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.lg,
    borderTopWidth: 1,
    gap: spacing.md,
  },
  bottomButton: {
    paddingVertical: 12,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
  },
  bottomButtonSecondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
  },
  thumbnail: {
    width: 40,
    height: 40,
    borderRadius: radius.sm,
    resizeMode: 'cover',
  },
  savedToast: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.xxl * 2,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 10,
  },
});
