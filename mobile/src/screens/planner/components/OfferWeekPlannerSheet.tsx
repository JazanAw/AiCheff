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
import { fontFamilies, radius, spacing, typography } from '../../../theme';
import type { ThemeColors } from '../../../theme';
import { Icon } from '../../../components/common/Icon';
import type { IconName } from '../../../components/common/Icon';
import { getCuisineLabel, type CuisineSlug } from '../../../utils/cuisine';

type TFunc = (k: string, opts?: Record<string, unknown>) => string;

export interface OfferPlanOptions {
  count: number;
  cuisine: CuisineSlug | 'all';
  usePantry: boolean;
  preferDeals: boolean;
  quickOnly: boolean;
}

interface Props {
  visible: boolean;
  /** Cuisines actually present in the loaded recipes (chips beyond "Gemischt"). */
  cuisineOptions: CuisineSlug[];
  colors: ThemeColors;
  t: TFunc;
  onClose: () => void;
  onGenerate: (options: OfferPlanOptions) => void;
}

const COUNT_CHOICES = [3, 5, 7];

/**
 * "Woche planen" options sheet — number of recipes, cuisine, and the three
 * planning toggles. Collects choices only; the planner runs in the caller.
 */
export function OfferWeekPlannerSheet({
  visible,
  cuisineOptions,
  colors,
  t,
  onClose,
  onGenerate,
}: Props) {
  const insets = useSafeAreaInsets();
  const { gesture, sheetStyle, scrollHandler, scrollRef } = useSwipeToDismiss({
    visible,
    onDismiss: onClose,
  });
  const [count, setCount] = useState(5);
  const [cuisine, setCuisine] = useState<CuisineSlug | 'all'>('all');
  const [usePantry, setUsePantry] = useState(true);
  const [preferDeals, setPreferDeals] = useState(true);
  const [quickOnly, setQuickOnly] = useState(false);

  // Reset to sensible defaults each time the sheet opens.
  useEffect(() => {
    if (visible) {
      setCount(5);
      setCuisine('all');
      setUsePantry(true);
      setPreferDeals(true);
      setQuickOnly(false);
    }
  }, [visible]);

  const showCuisine = cuisineOptions.length > 0;

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
            <View style={styles.headerText}>
              <Text style={[styles.title, { color: colors.text }]}>
                {t('planner.offerPlan.title')}
              </Text>
              <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
                {t('planner.offerPlan.subtitle')}
              </Text>
            </View>
            <Pressable onPress={onClose} hitSlop={10} style={[styles.closeBtn, { backgroundColor: colors.surface }]}>
              <Icon name="close" size={16} color={colors.textSecondary} />
            </Pressable>
          </View>

          <Reanimated.ScrollView
            ref={scrollRef}
            onScroll={scrollHandler}
            scrollEventThrottle={16}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.scrollContent}
          >
            {/* Anzahl Rezepte */}
            <FieldLabel colors={colors}>{t('planner.offerPlan.countLabel')}</FieldLabel>
            <View style={styles.segmented}>
              {COUNT_CHOICES.map((value) => {
                const active = value === count;
                return (
                  <Pressable
                    key={value}
                    onPress={() => setCount(value)}
                    style={[
                      styles.segment,
                      {
                        backgroundColor: active ? colors.primary : colors.surface,
                        borderColor: active ? colors.primary : colors.border,
                      },
                    ]}
                  >
                    <Text style={[styles.segmentText, { color: active ? '#FFFFFF' : colors.text }]}>
                      {value}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {/* Küche */}
            {showCuisine && (
              <>
                <FieldLabel colors={colors} top>
                  {t('planner.offerPlan.cuisineLabel')}
                </FieldLabel>
                <View style={styles.chipWrap}>
                  {(['all', ...cuisineOptions] as Array<CuisineSlug | 'all'>).map((slug) => {
                    const active = slug === cuisine;
                    return (
                      <Pressable
                        key={slug}
                        onPress={() => setCuisine(slug)}
                        style={[
                          styles.chip,
                          {
                            backgroundColor: active ? colors.primary : colors.surface,
                            borderColor: active ? colors.primary : colors.border,
                          },
                        ]}
                      >
                        <Text style={[styles.chipText, { color: active ? '#FFFFFF' : colors.text }]}>
                          {slug === 'all' ? t('planner.offerPlan.cuisineMixed') : getCuisineLabel(slug, t)}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </>
            )}

            {/* Optionen */}
            <FieldLabel colors={colors} top>
              {t('planner.offerPlan.optionsLabel')}
            </FieldLabel>
            <View style={[styles.optionGroup, { borderColor: colors.borderLight }]}>
              <OptionRow
                colors={colors}
                icon="pantry"
                title={t('planner.offerPlan.usePantryTitle')}
                sub={t('planner.offerPlan.usePantrySub')}
                on={usePantry}
                onToggle={() => setUsePantry((v) => !v)}
              />
              <View style={[styles.optionDivider, { borderColor: colors.borderLight }]} />
              <OptionRow
                colors={colors}
                icon="tag"
                title={t('planner.offerPlan.preferDealsTitle')}
                sub={t('planner.offerPlan.preferDealsSub')}
                on={preferDeals}
                onToggle={() => setPreferDeals((v) => !v)}
              />
              <View style={[styles.optionDivider, { borderColor: colors.borderLight }]} />
              <OptionRow
                colors={colors}
                icon="flash"
                title={t('planner.offerPlan.quickOnlyTitle')}
                sub={t('planner.offerPlan.quickOnlySub')}
                on={quickOnly}
                onToggle={() => setQuickOnly((v) => !v)}
              />
            </View>
          </Reanimated.ScrollView>

          <Pressable
            style={[styles.cta, { backgroundColor: colors.primary }]}
            onPress={() => onGenerate({ count, cuisine, usePantry, preferDeals, quickOnly })}
            accessibilityRole="button"
          >
            <Icon name="sparkle" size={18} color="#FFFFFF" active />
            <Text style={styles.ctaText}>{t('planner.offerPlan.generate')}</Text>
          </Pressable>
        </Reanimated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}

function FieldLabel({
  children,
  colors,
  top,
}: {
  children: React.ReactNode;
  colors: ThemeColors;
  top?: boolean;
}) {
  return (
    <Text style={[styles.fieldLabel, { color: colors.textTertiary, marginTop: top ? spacing.lg : 0 }]}>
      {children}
    </Text>
  );
}

function OptionRow({
  colors,
  icon,
  title,
  sub,
  on,
  onToggle,
}: {
  colors: ThemeColors;
  icon: IconName;
  title: string;
  sub: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <Pressable onPress={onToggle} style={styles.optionRow} accessibilityRole="switch" accessibilityState={{ checked: on }}>
      <View style={[styles.optionIcon, { backgroundColor: colors.surface }]}>
        <Icon name={icon} size={18} color={colors.primary} />
      </View>
      <View style={styles.optionTextWrap}>
        <Text style={[styles.optionTitle, { color: colors.text }]}>{title}</Text>
        <Text style={[styles.optionSub, { color: colors.textSecondary }]} numberOfLines={2}>
          {sub}
        </Text>
      </View>
      <View style={[styles.switch, { backgroundColor: on ? colors.primary : colors.border }]}>
        <View style={[styles.knob, { left: on ? 21 : 3 }]} />
      </View>
    </Pressable>
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
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
  headerText: { flex: 1, minWidth: 0 },
  title: { ...typography.h3 },
  subtitle: { fontSize: 13.5, fontFamily: fontFamilies.regular, marginTop: 3 },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
  },
  scrollContent: { paddingBottom: spacing.md },
  fieldLabel: {
    fontFamily: fontFamilies.bold,
    fontSize: 12,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  segmented: { flexDirection: 'row', gap: 8 },
  segment: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
  },
  segmentText: { fontSize: 16, fontFamily: fontFamilies.bold },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1 },
  chipText: { fontSize: 13, fontFamily: fontFamilies.semibold },
  optionGroup: { borderTopWidth: 1, borderBottomWidth: 1 },
  optionDivider: { borderTopWidth: 1, marginLeft: 50 },
  optionRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  optionIcon: {
    width: 38,
    height: 38,
    borderRadius: 11,
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
  },
  optionTextWrap: { flex: 1, minWidth: 0 },
  optionTitle: { fontSize: 14.5, fontFamily: fontFamilies.bold, letterSpacing: -0.1 },
  optionSub: { fontSize: 12.5, fontFamily: fontFamilies.regular, marginTop: 1 },
  switch: { width: 46, height: 28, borderRadius: 999, justifyContent: 'center', flexShrink: 0 },
  knob: {
    position: 'absolute',
    top: 3,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.25,
    shadowRadius: 2,
    elevation: 2,
  },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 15,
    borderRadius: radius.md,
    marginTop: spacing.sm,
  },
  ctaText: { color: '#FFFFFF', fontSize: 15, fontFamily: fontFamilies.bold },
});
