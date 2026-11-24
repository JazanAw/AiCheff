import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureDetector } from 'react-native-gesture-handler';
import Reanimated from 'react-native-reanimated';
import { useSwipeToDismiss } from '../../../components/common/useSwipeToDismiss';
import { fontFamilies, radius, spacing, typography } from '../../../theme';
import type { ThemeColors } from '../../../theme';
import { Icon } from '../../../components/common/Icon';
import type { PlannedShoppingItem } from '../../../utils/planning';
import type { WeeklyShoppingPreview } from '../../../services/weeklyShoppingFlow';

interface Props {
  visible: boolean;
  weekLabel: string;
  /** null while the preview is still loading. */
  preview: WeeklyShoppingPreview | null;
  loading: boolean;
  submitting: boolean;
  colors: ThemeColors;
  t: (k: string, opts?: Record<string, unknown>) => string;
  onClose: () => void;
  onConfirm: () => void;
}

function formatQuantity(item: PlannedShoppingItem): string {
  const qty = Number.isInteger(item.quantity)
    ? String(item.quantity)
    : item.quantity.toFixed(2).replace('.', ',');
  return item.unit ? `${qty} ${item.unit}` : qty;
}

/**
 * Review sheet for the "create weekly shopping list" action. Shows the merged,
 * pantry-aware items that would be added; confirm writes them. Pure UI — the
 * planner owns the load/commit logic.
 */
export function WeeklyShoppingListSheet({
  visible,
  weekLabel,
  preview,
  loading,
  submitting,
  colors,
  t,
  onClose,
  onConfirm,
}: Props) {
  const insets = useSafeAreaInsets();
  const { gesture, sheetStyle, backdropStyle, scrollHandler, scrollRef } = useSwipeToDismiss({
    visible,
    onDismiss: onClose,
    mode: 'standalone',
  });

  const items = preview?.items ?? [];
  const hasItems = items.length > 0;
  // Distinguish "everything already in the pantry" from "everything already on
  // the list" so the empty hint is accurate.
  const allInPantry = preview != null && preview.totalMissing === 0;

  const renderBody = () => {
    if (loading || !preview) {
      return (
        <View style={styles.placeholder}>
          <Text style={[typography.body, { color: colors.textSecondary }]}>
            {t('common.loading')}
          </Text>
        </View>
      );
    }
    if (!hasItems) {
      return (
        <View style={styles.placeholder}>
          <Icon name="check" size={28} color={colors.accent} strokeWidth={2.5} />
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            {allInPantry
              ? t('planner.weeklyShopping.allInPantry')
              : t('planner.weeklyShopping.nothingNew')}
          </Text>
        </View>
      );
    }
    return (
      <Reanimated.FlatList
        ref={scrollRef}
        onScroll={scrollHandler}
        scrollEventThrottle={16}
        data={items}
        keyExtractor={(item, i) => `${item.name}-${item.unit}-${i}`}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        ItemSeparatorComponent={() => <View style={{ height: 6 }} />}
        renderItem={({ item }) => (
          <View style={[styles.row, { borderColor: colors.borderLight }]}>
            <View style={styles.rowMain}>
              <Text style={[styles.rowName, { color: colors.text }]} numberOfLines={1}>
                {item.name}
              </Text>
              {item.dealId || item.storeName ? (
                <View style={styles.dealRow}>
                  <Icon name="tag" size={11} color={colors.accent} />
                  <Text style={[styles.dealText, { color: colors.accent }]} numberOfLines={1}>
                    {item.storeName ?? t('planner.weeklyShopping.deal')}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text style={[styles.rowQty, { color: colors.textSecondary }]} numberOfLines={1}>
              {formatQuantity(item)}
            </Text>
          </View>
        )}
      />
    );
  };

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={visible ? 'auto' : 'none'}>
      <Reanimated.View style={[styles.backdrop, backdropStyle]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      </Reanimated.View>

      <GestureDetector gesture={gesture}>
      <Reanimated.View
        style={[
          styles.sheet,
          {
            backgroundColor: colors.surfaceElevated,
            paddingBottom: insets.bottom + spacing.lg,
          },
          sheetStyle,
        ]}
      >
        <View style={[styles.handleBar, { backgroundColor: colors.border }]} />

        <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>
          {t('planner.weeklyShopping.title', { week: weekLabel })}
        </Text>
        {preview && hasItems ? (
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
            {t('planner.weeklyShopping.count', { count: items.length })}
            {preview.alreadyOnListCount > 0
              ? ` · ${t('planner.weeklyShopping.alreadyOnList', { count: preview.alreadyOnListCount })}`
              : ''}
          </Text>
        ) : null}

        {renderBody()}

        {preview && hasItems ? (
          <Text style={[styles.pantryNote, { color: colors.textTertiary }]}>
            {t('planner.weeklyShopping.pantryNote')}
          </Text>
        ) : null}

        <View style={styles.actions}>
          <Pressable
            style={[styles.cancelButton, { backgroundColor: colors.surface, borderColor: colors.border }]}
            onPress={onClose}
            disabled={submitting}
          >
            <Text style={[typography.button, { color: colors.text }]}>
              {t('common.cancel')}
            </Text>
          </Pressable>
          {hasItems ? (
            <Pressable
              style={[styles.confirmButton, { backgroundColor: colors.accent, opacity: submitting ? 0.6 : 1 }]}
              onPress={onConfirm}
              disabled={submitting}
            >
              <Icon name="cart-plus" size={17} color="#FFFFFF" />
              <Text style={[typography.button, { color: '#FFFFFF' }]}>
                {t('planner.weeklyShopping.confirm')}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </Reanimated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '85%',
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
  },
  handleBar: {
    width: 40,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: spacing.md,
  },
  title: { ...typography.h3, textAlign: 'center' },
  subtitle: { ...typography.bodySmall, textAlign: 'center', marginTop: 4 },
  list: { flexGrow: 0, marginTop: spacing.md },
  listContent: { paddingBottom: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowMain: { flex: 1, minWidth: 0 },
  rowName: { fontFamily: fontFamilies.semibold, fontSize: 15 },
  dealRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  dealText: { fontFamily: fontFamilies.medium, fontSize: 11.5 },
  rowQty: { fontFamily: fontFamilies.semibold, fontSize: 14 },
  placeholder: { paddingVertical: spacing.xxl, alignItems: 'center', gap: spacing.sm },
  emptyText: { ...typography.body, textAlign: 'center' },
  pantryNote: { ...typography.caption, textAlign: 'center', marginTop: spacing.sm },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  cancelButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
  },
  confirmButton: {
    flex: 2,
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
});
