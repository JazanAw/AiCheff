import React from 'react';
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
import { useSwipeToDismiss, type UseSwipeToDismiss } from '../../../components/common/useSwipeToDismiss';
import { fontFamilies, radius, spacing, typography } from '../../../theme';
import type { ThemeColors } from '../../../theme';
import { Icon } from '../../../components/common/Icon';
import { RecipeIllustration } from '../../../components/common/RecipeIllustration';
import { getCuisineLabel, normalizeCuisine } from '../../../utils/cuisine';
import type { RecipeOfferInfo } from '../../../utils/offerRecipes';
import type { OfferPlanReason } from '../../../utils/weeklyOfferPlanner';
import type { Recipe } from '../../../types';

type TFunc = (k: string, opts?: Record<string, unknown>) => string;

const DAY_KEYS = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
] as const;

export type OfferPlanPhase = 'list' | 'success' | 'error';

/** One suggestion already paired with the weekday slot it will be written to. */
export interface DaySuggestion {
  dayOfWeek: number;
  recipe: Recipe;
  offer: RecipeOfferInfo;
  reasons: OfferPlanReason[];
}

interface Props {
  visible: boolean;
  phase: OfferPlanPhase;
  weekNumber: number;
  suggestions: DaySuggestion[];
  /** Why the list is empty (only meaningful when suggestions is empty). */
  emptyReason?: 'no_offers' | 'too_few' | null;
  /** True when fewer suggestions were produced than requested due to full slots. */
  limitedBySlots?: boolean;
  submitting: boolean;
  /** Recipes actually written (drives the success headline). */
  plannedCount: number;
  colors: ThemeColors;
  t: TFunc;
  onClose: () => void;
  onReplace: (index: number) => void;
  onAccept: () => void;
  onCheckShopping: () => void;
}

/**
 * Suggestions sheet for the weekly offer planner. Renders three phases:
 *   - 'list'    — per-day suggestions with Ersetzen / Übernehmen (or empty state)
 *   - 'success' — "N Rezepte geplant" → Einkaufsliste prüfen
 *   - 'error'   — save failed → Erneut versuchen
 * Pure presentation; all persistence lives in the caller.
 */
export function OfferSuggestionsSheet({
  visible,
  phase,
  weekNumber,
  suggestions,
  emptyReason,
  limitedBySlots,
  submitting,
  plannedCount,
  colors,
  t,
  onClose,
  onReplace,
  onAccept,
  onCheckShopping,
}: Props) {
  const insets = useSafeAreaInsets();
  const { gesture, sheetStyle, scrollHandler, scrollRef } = useSwipeToDismiss({
    visible,
    onDismiss: onClose,
  });

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

          {phase === 'success' ? (
            <ResultBody
              colors={colors}
              tone="success"
              icon="check"
              title={t('planner.offerPlan.successTitle', { count: plannedCount })}
              body={t('planner.offerPlan.successBody')}
              primaryLabel={t('planner.offerPlan.successShopping')}
              primaryIcon="cart-plus"
              onPrimary={onCheckShopping}
              secondaryLabel={t('planner.offerPlan.successToPlan')}
              onSecondary={onClose}
            />
          ) : phase === 'error' ? (
            <ResultBody
              colors={colors}
              tone="error"
              icon="alert"
              title={t('planner.offerPlan.errorTitle')}
              body={t('planner.offerPlan.errorBody')}
              primaryLabel={t('planner.offerPlan.errorRetry')}
              primaryIcon="refresh"
              onPrimary={onAccept}
              secondaryLabel={t('common.cancel')}
              onSecondary={onClose}
              submitting={submitting}
            />
          ) : suggestions.length === 0 ? (
            <EmptyBody colors={colors} t={t} reason={emptyReason ?? 'too_few'} onClose={onClose} />
          ) : (
            <ListBody
              colors={colors}
              t={t}
              weekNumber={weekNumber}
              suggestions={suggestions}
              limitedBySlots={limitedBySlots}
              submitting={submitting}
              scrollRef={scrollRef}
              scrollHandler={scrollHandler}
              onClose={onClose}
              onReplace={onReplace}
              onAccept={onAccept}
            />
          )}
        </Reanimated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}

// ─── List phase ─────────────────────────────────────────────────────────────

function ListBody({
  colors,
  t,
  weekNumber,
  suggestions,
  limitedBySlots,
  submitting,
  scrollRef,
  scrollHandler,
  onClose,
  onReplace,
  onAccept,
}: {
  colors: ThemeColors;
  t: TFunc;
  weekNumber: number;
  suggestions: DaySuggestion[];
  limitedBySlots?: boolean;
  submitting: boolean;
  scrollRef: UseSwipeToDismiss['scrollRef'];
  scrollHandler: UseSwipeToDismiss['scrollHandler'];
  onClose: () => void;
  onReplace: (index: number) => void;
  onAccept: () => void;
}) {
  return (
    <>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={[styles.title, { color: colors.text }]}>
            {t('planner.offerPlan.suggestionsTitle', { week: weekNumber })}
          </Text>
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
            {t('planner.offerPlan.suggestionsSubtitle', { count: suggestions.length })}
          </Text>
        </View>
        <Pressable onPress={onClose} hitSlop={10} style={[styles.closeBtn, { backgroundColor: colors.surface }]}>
          <Icon name="close" size={16} color={colors.textSecondary} />
        </Pressable>
      </View>

      {limitedBySlots ? (
        <View style={[styles.note, { backgroundColor: colors.warningLight, borderColor: colors.warning + '33' }]}>
          <Icon name="info" size={15} color={colors.warning} />
          <Text style={[styles.noteText, { color: colors.text }]}>
            {t('planner.offerPlan.limitedNote', { count: suggestions.length })}
          </Text>
        </View>
      ) : null}

      <Reanimated.ScrollView
        ref={scrollRef}
        onScroll={scrollHandler}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.listContent}
      >
        {suggestions.map((s, index) => (
          <SuggestionRow
            key={`${s.dayOfWeek}-${s.recipe.id}`}
            colors={colors}
            t={t}
            suggestion={s}
            onReplace={() => onReplace(index)}
          />
        ))}
      </Reanimated.ScrollView>

      <View style={styles.footer}>
        <Pressable
          style={[styles.cancelBtn, { backgroundColor: colors.surface, borderColor: colors.border }]}
          onPress={onClose}
        >
          <Text style={[typography.button, { color: colors.text }]}>{t('common.cancel')}</Text>
        </Pressable>
        <Pressable
          style={[styles.acceptBtn, { backgroundColor: colors.accent, opacity: submitting ? 0.6 : 1 }]}
          onPress={onAccept}
          disabled={submitting}
        >
          <Icon name="check" size={17} color="#FFFFFF" strokeWidth={2.4} />
          <Text style={[typography.button, { color: '#FFFFFF' }]}>
            {submitting ? t('planner.offerPlan.saving') : t('planner.offerPlan.accept')}
          </Text>
        </Pressable>
      </View>
    </>
  );
}

function SuggestionRow({
  colors,
  t,
  suggestion,
  onReplace,
}: {
  colors: ThemeColors;
  t: TFunc;
  suggestion: DaySuggestion;
  onReplace: () => void;
}) {
  const { recipe, offer, reasons, dayOfWeek } = suggestion;
  return (
    <View style={[styles.row, { borderBottomColor: colors.borderLight }]}>
      <View style={styles.rowLeft}>
        <Text style={[styles.dayLabel, { color: colors.textTertiary }]}>
          {t(`planner.daysShort.${DAY_KEYS[dayOfWeek]}`)}
        </Text>
        <View style={styles.thumb}>
          <RecipeIllustration recipeId={recipe.id} />
        </View>
      </View>
      <View style={styles.rowBody}>
        <Text style={[styles.rowName, { color: colors.text }]} numberOfLines={2}>
          {recipe.name}
        </Text>
        <View style={styles.metaRow}>
          <View style={styles.metaItem}>
            <Icon name="clock" size={11} color={colors.textSecondary} />
            <Text style={[styles.metaText, { color: colors.textSecondary }]}>
              {t('cheffity.cookTime', { minutes: recipe.cookTimeMinutes })}
            </Text>
          </View>
          {recipe.cuisine ? (
            <Text style={[styles.metaText, { color: colors.textSecondary }]} numberOfLines={1}>
              {getCuisineLabel(normalizeCuisine(recipe.cuisine), t)}
            </Text>
          ) : null}
        </View>
        <View style={styles.reasonRow}>
          {reasons.map((reason, i) => (
            <ReasonPill key={i} colors={colors} t={t} reason={reason} accent={i === 0} />
          ))}
          {offer.stores.map((store) => (
            <View
              key={store}
              style={[styles.storeBadge, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}
            >
              <Text style={[styles.storeText, { color: colors.textSecondary }]}>{store}</Text>
            </View>
          ))}
        </View>
      </View>
      <Pressable onPress={onReplace} hitSlop={6} style={styles.replaceBtn} accessibilityLabel={t('planner.offerPlan.replace')}>
        <Icon name="swap" size={15} color={colors.textSecondary} />
        <Text style={[styles.replaceText, { color: colors.textSecondary }]}>
          {t('planner.offerPlan.replace')}
        </Text>
      </Pressable>
    </View>
  );
}

function ReasonPill({
  colors,
  t,
  reason,
  accent,
}: {
  colors: ThemeColors;
  t: TFunc;
  reason: OfferPlanReason;
  accent: boolean;
}) {
  let label: string;
  let icon: 'tag' | undefined;
  switch (reason.kind) {
    case 'on_deal':
      label = t('cheffity.pantryView.statOnDeal', { count: reason.count });
      icon = 'tag';
      break;
    case 'missing':
      label = t('planner.offerPlan.reasonMissing', { count: reason.count });
      break;
    case 'cost':
      label = t('planner.offerPlan.reasonCost', {
        cost: reason.amount.toFixed(2).replace('.', ','),
      });
      break;
    case 'from_pantry':
      label = t('planner.offerPlan.reasonFromPantry');
      break;
    case 'quick':
      label = t('cheffity.reasons.quick');
      break;
  }
  const bg = accent ? colors.accentLight : colors.surface;
  const fg = accent ? colors.accent : colors.textSecondary;
  return (
    <View style={[styles.reasonPill, { backgroundColor: bg }]}>
      {icon ? <Icon name={icon} size={11} color={fg} active /> : null}
      <Text style={[styles.reasonText, { color: fg }]}>{label}</Text>
    </View>
  );
}

// ─── Empty phase ────────────────────────────────────────────────────────────

function EmptyBody({
  colors,
  t,
  reason,
  onClose,
}: {
  colors: ThemeColors;
  t: TFunc;
  reason: 'no_offers' | 'too_few';
  onClose: () => void;
}) {
  const titleKey =
    reason === 'no_offers' ? 'planner.offerPlan.emptyNoOffersTitle' : 'planner.offerPlan.emptyTooFewTitle';
  const bodyKey =
    reason === 'no_offers' ? 'planner.offerPlan.emptyNoOffersBody' : 'planner.offerPlan.emptyTooFewBody';
  return (
    <View style={styles.resultWrap}>
      <View style={[styles.resultIcon, { backgroundColor: colors.warningLight }]}>
        <Icon name="plan" size={28} color={colors.warning} />
      </View>
      <Text style={[styles.resultTitle, { color: colors.text }]}>{t(titleKey)}</Text>
      <Text style={[styles.resultBody, { color: colors.textSecondary }]}>{t(bodyKey)}</Text>
      <Pressable style={[styles.resultPrimary, { backgroundColor: colors.primary }]} onPress={onClose}>
        <Text style={styles.resultPrimaryText}>{t('planner.offerPlan.emptyClose')}</Text>
      </Pressable>
    </View>
  );
}

// ─── Success / error phase ──────────────────────────────────────────────────

function ResultBody({
  colors,
  tone,
  icon,
  title,
  body,
  primaryLabel,
  primaryIcon,
  onPrimary,
  secondaryLabel,
  onSecondary,
  submitting,
}: {
  colors: ThemeColors;
  tone: 'success' | 'error';
  icon: 'check' | 'alert';
  title: string;
  body: string;
  primaryLabel: string;
  primaryIcon: 'cart-plus' | 'refresh';
  onPrimary: () => void;
  secondaryLabel: string;
  onSecondary: () => void;
  submitting?: boolean;
}) {
  const ring = tone === 'success' ? colors.accentLight : colors.errorLight;
  const fg = tone === 'success' ? colors.accent : colors.error;
  const primaryBg = tone === 'success' ? colors.accent : colors.primary;
  return (
    <View style={styles.resultWrap}>
      <View style={[styles.resultIcon, { backgroundColor: ring }]}>
        <Icon name={icon} size={30} color={fg} strokeWidth={tone === 'success' ? 2.4 : 1.8} />
      </View>
      <Text style={[styles.resultTitle, { color: colors.text }]}>{title}</Text>
      <Text style={[styles.resultBody, { color: colors.textSecondary }]}>{body}</Text>
      <Pressable
        style={[styles.resultPrimary, { backgroundColor: primaryBg, opacity: submitting ? 0.6 : 1 }]}
        onPress={onPrimary}
        disabled={submitting}
      >
        <Icon name={primaryIcon} size={17} color="#FFFFFF" />
        <Text style={styles.resultPrimaryText}>{primaryLabel}</Text>
      </Pressable>
      <Pressable onPress={onSecondary} style={styles.resultSecondary} hitSlop={6}>
        <Text style={[styles.resultSecondaryText, { color: colors.textSecondary }]}>{secondaryLabel}</Text>
      </Pressable>
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
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
  headerText: { flex: 1, minWidth: 0 },
  title: { ...typography.h3 },
  subtitle: { fontSize: 13, fontFamily: fontFamilies.regular, marginTop: 3 },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
  },
  note: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 9,
    paddingHorizontal: 11,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: spacing.sm,
  },
  noteText: { flex: 1, fontSize: 12.5, fontFamily: fontFamilies.semibold },
  listContent: { paddingBottom: spacing.sm },
  row: { flexDirection: 'row', gap: 12, paddingVertical: 12, borderBottomWidth: 1 },
  rowLeft: { alignItems: 'center', width: 38, flexShrink: 0, gap: 5 },
  dayLabel: {
    fontFamily: fontFamilies.bold,
    fontSize: 11,
    letterSpacing: 0.2,
    textTransform: 'uppercase',
  },
  thumb: { width: 38, height: 38, borderRadius: 10, overflow: 'hidden', backgroundColor: '#0002' },
  rowBody: { flex: 1, minWidth: 0, gap: 5 },
  rowName: {
    fontFamily: fontFamilies.displaySemibold,
    fontSize: 15,
    lineHeight: 18,
    letterSpacing: -0.2,
  },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  metaText: { fontFamily: fontFamilies.regular, fontSize: 11.5 },
  reasonRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 2 },
  reasonPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 999,
  },
  reasonText: { fontSize: 11, fontFamily: fontFamilies.semibold, letterSpacing: -0.1 },
  storeBadge: { paddingVertical: 3, paddingHorizontal: 8, borderRadius: 7, borderWidth: 1 },
  storeText: { fontSize: 11, fontFamily: fontFamilies.semibold },
  replaceBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', paddingTop: 2 },
  replaceText: { fontSize: 12, fontFamily: fontFamilies.semibold },
  footer: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  cancelBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
  },
  acceptBtn: {
    flex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: radius.md,
  },
  // success / error / empty
  resultWrap: { alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.lg, gap: spacing.xs },
  resultIcon: {
    width: 66,
    height: 66,
    borderRadius: 33,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  resultTitle: {
    fontFamily: fontFamilies.displaySemibold,
    fontSize: 22,
    letterSpacing: -0.4,
    textAlign: 'center',
  },
  resultBody: {
    fontSize: 13.5,
    fontFamily: fontFamilies.regular,
    textAlign: 'center',
    lineHeight: 19,
    maxWidth: 280,
    marginTop: 4,
    marginBottom: spacing.md,
  },
  resultPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    alignSelf: 'stretch',
    paddingVertical: 15,
    borderRadius: radius.md,
  },
  resultPrimaryText: { color: '#FFFFFF', fontSize: 15, fontFamily: fontFamilies.bold },
  resultSecondary: { marginTop: spacing.sm, paddingVertical: 6 },
  resultSecondaryText: { fontSize: 14, fontFamily: fontFamilies.bold },
});
