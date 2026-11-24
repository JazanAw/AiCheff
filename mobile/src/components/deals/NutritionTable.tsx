import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { fontFamilies } from '../../theme';
import { NutritionInfo, SubscriptionTier } from '../../types';
import { Icon } from '../common/Icon';
import { useDealsTheme } from './dealsTheme';

const TIER_RANK: Record<SubscriptionTier, number> = { free: 0, plus: 1, premium: 2 };

interface RowDef {
  key: keyof NutritionInfo;
  labelKey: string;
  /** Minimum tier required to see the value. Mirrors the handoff gate:
   *  Plus → kcal + protein, Premium → full macros. */
  tier: SubscriptionTier;
  unit: string;
}

const ROWS: RowDef[] = [
  { key: 'calories', labelKey: 'deals.nutrition.energy', tier: 'plus', unit: 'kcal' },
  { key: 'protein', labelKey: 'deals.nutrition.protein', tier: 'plus', unit: 'g' },
  { key: 'carbs', labelKey: 'deals.nutrition.carbs', tier: 'premium', unit: 'g' },
  { key: 'fat', labelKey: 'deals.nutrition.fat', tier: 'premium', unit: 'g' },
  { key: 'sugar', labelKey: 'deals.nutrition.sugar', tier: 'premium', unit: 'g' },
  { key: 'salt', labelKey: 'deals.nutrition.salt', tier: 'premium', unit: 'g' },
];

interface Props {
  tier: SubscriptionTier;
  nutrition?: NutritionInfo;
  onUpgrade?: () => void;
}

export function NutritionTable({ tier, nutrition, onUpgrade }: Props) {
  const { t } = useTranslation();
  const { colors, dark, locked } = useDealsTheme();

  if (!nutrition) {
    return (
      <View style={[styles.emptyBox, { backgroundColor: dark ? '#1A1A1A' : '#F8F9FA', borderColor: colors.border }]}>
        <Icon name="info" size={16} color={colors.textTertiary} />
        <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
          {t('deals.fallback.noNutrition')}
        </Text>
      </View>
    );
  }

  const fmt = (value: number | undefined, unit: string): string => {
    if (value == null) return '—';
    const num = Number.isInteger(value) ? String(value) : value.toFixed(1).replace('.', ',');
    return `${num} ${unit}`;
  };

  return (
    <View style={[styles.table, { backgroundColor: dark ? '#1A1A1A' : '#F8F9FA', borderColor: colors.border }]}>
      {ROWS.map((row, i) => {
        const show = TIER_RANK[tier] >= TIER_RANK[row.tier];
        const value = nutrition[row.key] as number | undefined;
        return (
          <View
            key={row.key}
            style={[
              styles.row,
              {
                borderBottomWidth: i < ROWS.length - 1 ? 1 : 0,
                borderBottomColor: colors.borderLight,
                backgroundColor: show ? 'transparent' : dark ? '#16131A' : '#F3EFFA',
              },
            ]}
          >
            <View style={styles.labelWrap}>
              <Text style={[styles.label, { color: show ? colors.text : colors.textTertiary }]}>
                {t(row.labelKey)}
              </Text>
              {!show && <Icon name="lock" size={12} color={locked.fg} />}
            </View>
            <Text style={[styles.value, { color: show ? colors.text : colors.textTertiary }]}>
              {show ? fmt(value, row.unit) : '•••'}
            </Text>
          </View>
        );
      })}

      {tier !== 'premium' && (
        <View style={[styles.footer, { backgroundColor: locked.bg, borderTopColor: colors.borderLight }]}>
          <View style={styles.footerText}>
            <Text style={[styles.footerTitle, { color: dark ? '#D9CCFF' : '#4A2F8E' }]}>
              {tier === 'free' ? t('deals.upsell.plusTitle') : t('deals.upsell.premiumTitle')}
            </Text>
            <Text style={[styles.footerSub, { color: colors.textSecondary }]}>
              {tier === 'free' ? t('deals.upsell.plusDesc') : t('deals.upsell.premiumDesc')}
            </Text>
          </View>
          <Pressable onPress={onUpgrade} style={[styles.upgradeBtn, { backgroundColor: locked.button }]}>
            <Icon name="sparkle" size={13} color="#fff" active />
            <Text style={styles.upgradeText}>{t('deals.upsell.upgrade')}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  emptyBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  emptyText: { fontSize: 13.5, fontFamily: fontFamilies.medium },
  table: { borderRadius: 12, borderWidth: 1, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 10 },
  labelWrap: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  label: { fontSize: 13.5, fontFamily: fontFamilies.medium },
  value: { fontSize: 13.5, fontFamily: fontFamilies.bold },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderTopWidth: 1 },
  footerText: { flex: 1, minWidth: 0 },
  footerTitle: { fontSize: 13, fontFamily: fontFamilies.bold },
  footerSub: { fontSize: 11, fontFamily: fontFamilies.regular, marginTop: 1 },
  upgradeBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
  upgradeText: { fontSize: 12.5, fontFamily: fontFamilies.bold, color: '#fff' },
});
