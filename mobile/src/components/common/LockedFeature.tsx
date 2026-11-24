import React from 'react';
import { StyleSheet, Text, View, Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation, NavigationProp } from '@react-navigation/native';
import { useThemeColors, typography, spacing, radius } from '../../theme';
import { SubscriptionTier } from '../../types';

interface Props {
  requiredTier: SubscriptionTier;
  onUpgrade?: () => void;
  children?: React.ReactNode;
}

export function LockedFeature({ requiredTier, onUpgrade, children }: Props) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const navigation = useNavigation<NavigationProp<Record<string, object | undefined>>>();

  const tierLabel = t(`subscription.${requiredTier}`);

  const handleUpgrade = () => {
    if (onUpgrade) {
      onUpgrade();
      return;
    }
    navigation.navigate('Profile', { screen: 'Subscription' });
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {children}
      <View style={[styles.overlay, { backgroundColor: colors.overlay }]}>
        <View style={[styles.card, { backgroundColor: colors.surfaceElevated }]}>
          <Text style={[typography.h3, { color: colors.text, textAlign: 'center' }]}>
            {t('upgrade.title')}
          </Text>
          <Text
            style={[
              typography.body,
              { color: colors.textSecondary, textAlign: 'center', marginTop: spacing.sm },
            ]}
          >
            {t('upgrade.description', { plan: tierLabel })}
          </Text>
          <Pressable
            style={[styles.button, { backgroundColor: colors.primary }]}
            onPress={handleUpgrade}
          >
            <Text style={[typography.button, { color: '#FFFFFF' }]}>
              {t('upgrade.button')}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  card: {
    padding: spacing.xl,
    borderRadius: radius.lg,
    width: '100%',
    maxWidth: 320,
    alignItems: 'center',
  },
  button: {
    marginTop: spacing.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.md,
  },
});
