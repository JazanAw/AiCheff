import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import * as WebBrowser from 'expo-web-browser';
import { useThemeColors, typography, spacing, radius } from '../../theme';
import { useSubscription } from '../../store/SubscriptionContext';
import { SubscriptionTier } from '../../types';
import {
  EXTERNAL_STRIPE_CHECKOUT_ENABLED,
  openStripePortal,
  startStripeCheckout,
} from '../../services/subscriptionApi';

const TIER_FEATURES: Record<SubscriptionTier, string[]> = {
  free: ['allDeals', 'basicFilters', 'shoppingList', 'categorizedDeals'],
  plus: [
    'noAds', 'nutrition', 'priceHistory', 'notifications',
    'compareStores', 'shareList', 'cheffity',
  ],
  premium: [
    'fullNutrition', 'cheapestStore', 'unlimitedCompare',
    'exportList', 'earlyAccess', 'unlimitedCheffity', 'dietTracking',
  ],
};

const TIER_PRICES: Record<SubscriptionTier, string | null> = {
  free: null,
  plus: '2,99',
  premium: '5,99',
};

interface Props {
  onBack: () => void;
}

export function SubscriptionScreen({ onBack }: Props) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { tier: currentTier } = useSubscription();

  // External Stripe checkout is gated behind an env flag — store/release
  // builds keep it off so no external-payment flow runs (see docs/stripe-integration.md).
  const checkoutEnabled = EXTERNAL_STRIPE_CHECKOUT_ENABLED;
  // Identifies the in-flight action ("checkout:plus", "portal", …) or null.
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const anyBusy = busyAction !== null;

  const openStripeUrl = async (
    action: string,
    getUrl: () => Promise<string>,
  ): Promise<void> => {
    if (!checkoutEnabled) {
      Alert.alert(
        t('subscription.checkout.unavailableTitle'),
        t('subscription.checkout.unavailableBody'),
      );
      return;
    }
    setBusyAction(action);
    try {
      const url = await getUrl();
      await WebBrowser.openBrowserAsync(url);
    } catch {
      Alert.alert(t('common.error'), t('subscription.checkout.error'));
    } finally {
      setBusyAction(null);
    }
  };

  const handleSubscribe = (tier: SubscriptionTier) => {
    if (tier === 'free') {
      return;
    }
    // tier is narrowed to 'plus' | 'premium' here, matching startStripeCheckout.
    void openStripeUrl(`checkout:${tier}`, () => startStripeCheckout(tier));
  };

  const handleManageSubscription = () => {
    void openStripeUrl('portal', openStripePortal);
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={onBack}>
          <Text style={[typography.button, { color: colors.primary }]}>{t('common.back')}</Text>
        </Pressable>
        <Text style={[typography.h3, { color: colors.text }]}>{t('profile.subscription')}</Text>
        <View style={{ width: 50 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {!checkoutEnabled && (
          <View
            style={[
              styles.notice,
              { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
            ]}
          >
            <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>
              {t('subscription.checkout.unavailableBody')}
            </Text>
          </View>
        )}

        {currentTier !== 'free' && (
          <Pressable
            style={[
              styles.manageButton,
              { borderColor: colors.primary },
              (!checkoutEnabled || anyBusy) && styles.buttonDisabled,
            ]}
            onPress={handleManageSubscription}
            disabled={!checkoutEnabled || anyBusy}
          >
            {busyAction === 'portal' ? (
              <ActivityIndicator color={colors.primary} />
            ) : (
              <Text style={[typography.button, { color: colors.primary }]}>
                {t('subscription.checkout.manage')}
              </Text>
            )}
          </Pressable>
        )}

        {(['free', 'plus', 'premium'] as SubscriptionTier[]).map((tier) => {
          const isCurrent = currentTier === tier;
          const isHighlighted = tier === 'plus';
          return (
            <View
              key={tier}
              style={[
                styles.tierCard,
                {
                  backgroundColor: colors.surfaceElevated,
                  borderColor: isHighlighted ? colors.primary : colors.border,
                  borderWidth: isHighlighted ? 2 : 1,
                },
              ]}
            >
              <View style={styles.tierHeader}>
                <Text style={[typography.h2, { color: colors.text }]}>
                  {t(`subscription.${tier}`)}
                </Text>
                {TIER_PRICES[tier] ? (
                  <Text style={[typography.h3, { color: colors.primary }]}>
                    EUR {TIER_PRICES[tier]}{t('common.perMonth')}
                  </Text>
                ) : (
                  <Text style={[typography.h3, { color: colors.accent }]}>
                    {t('subscription.free')}
                  </Text>
                )}
              </View>

              <Text style={[typography.bodySmall, { color: colors.textSecondary, marginBottom: spacing.md }]}>
                {t(`subscription.${tier}Description`)}
              </Text>

              {TIER_FEATURES[tier].map((feature) => (
                <View key={feature} style={styles.featureRow}>
                  <Text style={[typography.caption, { color: colors.accent }]}>{'✓'}</Text>
                  <Text style={[typography.bodySmall, { color: colors.text, flex: 1 }]}>
                    {t(`subscription.features.${feature}`)}
                  </Text>
                </View>
              ))}

              {isCurrent ? (
                <View style={[styles.currentBadge, { backgroundColor: colors.accentLight }]}>
                  <Text style={[typography.buttonSmall, { color: colors.accent }]}>
                    {t('profile.currentPlan')}
                  </Text>
                </View>
              ) : tier !== 'free' ? (
                <Pressable
                  style={[
                    styles.subscribeButton,
                    { backgroundColor: colors.primary },
                    (!checkoutEnabled || anyBusy) && styles.buttonDisabled,
                  ]}
                  onPress={() => handleSubscribe(tier)}
                  disabled={!checkoutEnabled || anyBusy}
                >
                  {busyAction === `checkout:${tier}` ? (
                    <ActivityIndicator color="#FFF" />
                  ) : (
                    <Text style={[typography.button, { color: '#FFF' }]}>
                      {t('profile.upgradeToPlan', { plan: t(`subscription.${tier}`) })}
                    </Text>
                  )}
                </Pressable>
              ) : null}
            </View>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  content: {
    padding: spacing.lg,
    gap: spacing.lg,
    paddingBottom: spacing.xxl * 2,
  },
  notice: {
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  manageButton: {
    paddingVertical: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  tierCard: {
    padding: spacing.lg,
    borderRadius: radius.lg,
  },
  tierHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  featureRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingVertical: 3,
    alignItems: 'center',
  },
  subscribeButton: {
    marginTop: spacing.lg,
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  currentBadge: {
    marginTop: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    alignItems: 'center',
  },
});
