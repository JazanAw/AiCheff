import React, { useEffect, useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Reanimated from 'react-native-reanimated';
import { useSwipeToDismiss } from '../../../components/common/useSwipeToDismiss';
import { fontFamilies, radius, spacing } from '../../../theme';
import type { ThemeColors } from '../../../theme';
import { Icon } from '../../../components/common/Icon';
import { ProductThumb, thumbSeed, thumbTint } from '../../../components/deals/ProductThumb';
import { formatEuro, formatShortDate } from '../../../components/deals/dealsTheme';
import { addShoppingItem } from '../../../services/shoppingListApi';
import {
  buildIngredientDealShoppingItem,
} from '../../../utils/ingredientDeal';
import type { RecipeIngredient } from '../../../types';

type TFunc = (k: string, opts?: Record<string, unknown>) => string;

interface Props {
  visible: boolean;
  /** The tapped offer ingredient (carries the concrete deal data). */
  ingredient: RecipeIngredient | null;
  /** Current recipe id — stored on the shopping row. */
  recipeId: string;
  colors: ThemeColors;
  t: TFunc;
  onClose: () => void;
}

type AddState = 'idle' | 'pending' | 'done' | 'error';

/**
 * Bottom sheet that shows the CONCRETE deal behind an offer ingredient —
 * product, store, price, validity — and lets the user add exactly that deal to
 * the shopping list. Only ever opened for ingredients with real deal data
 * (`ingredientHasConcreteDeal`), so every field shown is real; nothing is
 * invented. Optional fields are simply omitted when absent.
 */
export function IngredientDealSheet({
  visible,
  ingredient,
  recipeId,
  colors,
  t,
  onClose,
}: Props) {
  const insets = useSafeAreaInsets();
  const [addState, setAddState] = useState<AddState>('idle');
  const { gesture, sheetStyle, scrollHandler, scrollRef } = useSwipeToDismiss({
    visible,
    onDismiss: onClose,
  });

  // Reset the CTA whenever a different ingredient opens the sheet.
  useEffect(() => {
    setAddState('idle');
  }, [ingredient?.id, visible]);

  if (!ingredient) return null;

  const productName =
    ingredient.dealName && ingredient.dealName.trim().length > 0
      ? ingredient.dealName
      : ingredient.name;
  const seedKey = ingredient.dealId || ingredient.dealName || ingredient.name;
  const hasPrice = ingredient.dealPrice != null;
  const hasOriginal =
    ingredient.dealOriginalPrice != null &&
    ingredient.dealPrice != null &&
    ingredient.dealOriginalPrice > ingredient.dealPrice;
  const validFrom = ingredient.dealValidFrom ? formatShortDate(ingredient.dealValidFrom) : null;
  const validTo = ingredient.dealValidTo ? formatShortDate(ingredient.dealValidTo) : null;
  const amountText = `${ingredient.amount}${ingredient.unit ? ` ${ingredient.unit}` : ''}`;

  const validityLabel =
    validFrom && validTo
      ? t('cheffity.detail.dealSheet.validRange', { from: validFrom, to: validTo })
      : validTo
        ? t('cheffity.detail.dealSheet.validUntil', { date: validTo })
        : null;

  const handleAdd = async () => {
    if (addState === 'pending' || addState === 'done') return;
    setAddState('pending');
    try {
      await addShoppingItem(buildIngredientDealShoppingItem(ingredient, recipeId));
      setAddState('done');
    } catch (e) {
      console.warn('[IngredientDealSheet] addShoppingItem failed:', (e as Error).message);
      setAddState('error');
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
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

          <Reanimated.ScrollView
            ref={scrollRef}
            onScroll={scrollHandler}
            scrollEventThrottle={16}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.scroll}
          >
            {/* Hero: product thumb + store + name */}
            <View style={styles.hero}>
              <ProductThumb
                imageUrl={ingredient.dealImageUrl}
                seed={thumbSeed(seedKey)}
                tint={thumbTint(seedKey)}
                size={72}
                radius={14}
              />
              <View style={styles.heroBody}>
                {ingredient.dealStoreName ? (
                  <View style={[styles.storeBadge, { backgroundColor: colors.primaryLight }]}>
                    <Icon name="pin" size={12} color={colors.primary} />
                    <Text style={[styles.storeText, { color: colors.primary }]} numberOfLines={1}>
                      {ingredient.dealStoreName}
                    </Text>
                  </View>
                ) : null}
                <Text style={[styles.productName, { color: colors.text }]} numberOfLines={3}>
                  {productName}
                </Text>
              </View>
              <Pressable onPress={onClose} hitSlop={8} style={[styles.closeBtn, { backgroundColor: colors.surface }]}>
                <Icon name="close" size={16} color={colors.textSecondary} />
              </Pressable>
            </View>

            {/* Price band — only when a real price exists. */}
            {hasPrice ? (
              <View style={[styles.priceBand, { backgroundColor: colors.primaryLight, borderColor: colors.primary + '33' }]}>
                <View style={styles.priceRow}>
                  <Text style={[styles.priceBig, { color: colors.deal }]}>
                    {formatEuro(ingredient.dealPrice as number)}
                  </Text>
                  {hasOriginal ? (
                    <Text style={[styles.priceWas, { color: colors.textTertiary }]}>
                      {formatEuro(ingredient.dealOriginalPrice as number)}
                    </Text>
                  ) : null}
                </View>
                {ingredient.discountPercent != null && ingredient.discountPercent > 0 ? (
                  <View style={[styles.discountBadge, { backgroundColor: colors.deal }]}>
                    <Text style={styles.discountText}>-{ingredient.discountPercent}%</Text>
                  </View>
                ) : null}
              </View>
            ) : null}

            {/* Meta — what it matches, recipe amount, validity. */}
            <View style={styles.metaBlock}>
              <MetaRow
                colors={colors}
                icon="cheffity-hat"
                label={t('cheffity.detail.dealSheet.matchesIngredient', { name: ingredient.name })}
              />
              <MetaRow
                colors={colors}
                icon="cart"
                label={t('cheffity.detail.dealSheet.recipeAmount', { amount: amountText })}
              />
              {validityLabel ? (
                <MetaRow colors={colors} icon="clock" label={validityLabel} />
              ) : null}
            </View>
          </Reanimated.ScrollView>

          {/* CTA */}
          <View style={styles.ctaWrap}>
            {addState === 'error' ? (
              <Text style={[styles.errorText, { color: colors.error }]}>
                {t('cheffity.detail.dealSheet.addError')}
              </Text>
            ) : null}
            <Pressable
              onPress={handleAdd}
              disabled={addState === 'pending' || addState === 'done'}
              style={[
                styles.cta,
                {
                  backgroundColor: addState === 'done' ? colors.success : colors.accent,
                  opacity: addState === 'pending' ? 0.6 : 1,
                },
              ]}
              accessibilityRole="button"
            >
              <Icon
                name={addState === 'done' ? 'check' : 'cart-plus'}
                size={18}
                color="#FFFFFF"
                active={addState !== 'done'}
                strokeWidth={addState === 'done' ? 3 : 1.8}
              />
              <Text style={styles.ctaText}>
                {addState === 'done'
                  ? t('cheffity.detail.dealSheet.added')
                  : t('cheffity.detail.dealSheet.addToList')}
              </Text>
            </Pressable>
          </View>
        </Reanimated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}

function MetaRow({
  colors,
  icon,
  label,
}: {
  colors: ThemeColors;
  icon: React.ComponentProps<typeof Icon>['name'];
  label: string;
}) {
  return (
    <View style={styles.metaRow}>
      <View style={[styles.metaIcon, { backgroundColor: colors.surface }]}>
        <Icon name={icon} size={15} color={colors.textSecondary} />
      </View>
      <Text style={[styles.metaLabel, { color: colors.text }]}>{label}</Text>
    </View>
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
  handleBar: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: spacing.sm },
  scroll: { paddingBottom: spacing.sm },
  hero: { flexDirection: 'row', alignItems: 'flex-start', gap: 14, paddingTop: spacing.xs },
  heroBody: { flex: 1, minWidth: 0, gap: 6, paddingTop: 2 },
  storeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    paddingVertical: 4,
    paddingHorizontal: 9,
    borderRadius: 999,
  },
  storeText: { fontSize: 12, fontFamily: fontFamilies.bold, letterSpacing: -0.1 },
  productName: {
    fontFamily: fontFamilies.displaySemibold,
    fontSize: 19,
    lineHeight: 23,
    letterSpacing: -0.3,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
  },
  priceBand: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.md,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: 1,
  },
  priceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  priceBig: { fontFamily: fontFamilies.displayBold, fontSize: 28, letterSpacing: -0.8, lineHeight: 30 },
  priceWas: { fontSize: 14, textDecorationLine: 'line-through', fontFamily: fontFamilies.medium },
  discountBadge: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  discountText: { color: '#FFFFFF', fontSize: 13, fontFamily: fontFamilies.bold },
  metaBlock: { marginTop: spacing.md, gap: 10 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  metaIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
  },
  metaLabel: { flex: 1, fontSize: 14, fontFamily: fontFamilies.medium, letterSpacing: -0.1 },
  ctaWrap: { marginTop: spacing.md, gap: 8 },
  errorText: { fontSize: 13, fontFamily: fontFamilies.semibold, textAlign: 'center' },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 15,
    borderRadius: radius.md,
  },
  ctaText: { color: '#FFFFFF', fontSize: 15, fontFamily: fontFamilies.bold, letterSpacing: -0.1 },
});
