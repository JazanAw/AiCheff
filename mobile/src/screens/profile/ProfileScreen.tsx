import React from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { useThemeColors, typography, spacing, radius } from '../../theme';
import type { ThemeColors } from '../../theme';
import { useAuth } from '../../store/AuthContext';
import { useSubscription } from '../../store/SubscriptionContext';
import { Icon } from '../../components/common/Icon';
import type { Language } from '../../types';

const LANGUAGES: { code: Language; label: string }[] = [
  { code: 'de', label: 'Deutsch' },
  { code: 'en', label: 'English' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'it', label: 'Italiano' },
  { code: 'es', label: 'Español' },
  { code: 'pl', label: 'Polski' },
];

interface Props {
  onClose: () => void;
  onNavigateToPreferences: () => void;
  onNavigateToSubscription: () => void;
  onNavigateToTrends: () => void;
  onNavigateToFavorites: () => void;
}

export function ProfileScreen({
  onClose,
  onNavigateToPreferences,
  onNavigateToSubscription,
  onNavigateToTrends,
  onNavigateToFavorites,
}: Props) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { user, signOut, deleteAccount } = useAuth();
  const { tier, hasFeature } = useSubscription();

  const handleLanguageChange = (lang: Language) => {
    i18n.changeLanguage(lang);
  };

  const handleLogout = () => {
    Alert.alert(t('auth.logout'), '', [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('auth.logout'), style: 'destructive', onPress: signOut },
    ]);
  };

  const handleDeleteAccount = () => {
    Alert.alert(t('auth.deleteAccount'), t('auth.deleteAccountConfirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('common.delete'), style: 'destructive', onPress: deleteAccount },
    ]);
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
      <View style={styles.topBar}>
        <Pressable
          onPress={onClose}
          hitSlop={10}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
        >
          <Icon name="arrow-left" size={24} color={colors.text} />
        </Pressable>
        <Text style={[typography.h3, { color: colors.text }]}>{t('profile.title')}</Text>
        <View style={styles.backButton} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>

        {/* User info */}
        <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
          <Text style={[typography.body, { color: colors.text }]}>{user?.email ?? ''}</Text>
          <View style={[styles.tierBadge, { backgroundColor: colors.primaryLight }]}>
            <Text style={[typography.buttonSmall, { color: colors.primary }]}>
              {t(`subscription.${tier}`)}
            </Text>
          </View>
        </View>

        {/* Subscription */}
        <Text style={[typography.label, { color: colors.textSecondary, marginTop: spacing.xl }]}>
          {t('profile.subscription')}
        </Text>
        <MenuItem
          label={t('profile.currentPlan') + ': ' + t(`subscription.${tier}`)}
          onPress={onNavigateToSubscription}
          colors={colors}
        />

        {/* Preferences */}
        <Text style={[typography.label, { color: colors.textSecondary, marginTop: spacing.xl }]}>
          {t('profile.preferences')}
        </Text>
        <MenuItem
          label={t('profile.preferences')}
          onPress={onNavigateToPreferences}
          colors={colors}
        />

        {/* Favoriten — zeigt je Favorit, ob und wo er gerade im Angebot ist */}
        <MenuItem
          label={t('favorites.title')}
          onPress={onNavigateToFavorites}
          colors={colors}
        />

        {/* Trends (Plus/Premium) */}
        {hasFeature('cheffity') && (
          <MenuItem
            label={t('trends.title')}
            onPress={onNavigateToTrends}
            colors={colors}
          />
        )}

        {/* Language */}
        <Text style={[typography.label, { color: colors.textSecondary, marginTop: spacing.xl }]}>
          {t('profile.language')}
        </Text>
        <View style={[styles.languageGrid]}>
          {LANGUAGES.map((lang) => {
            const isActive = i18n.language === lang.code;
            return (
              <Pressable
                key={lang.code}
                style={[
                  styles.langChip,
                  {
                    backgroundColor: isActive ? colors.primaryLight : colors.surface,
                    borderColor: isActive ? colors.primary : colors.border,
                  },
                ]}
                onPress={() => handleLanguageChange(lang.code)}
              >
                <Text
                  style={[
                    typography.bodySmall,
                    { color: isActive ? colors.primary : colors.text, fontWeight: isActive ? '600' : '400' },
                  ]}
                >
                  {lang.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* About */}
        <Text style={[typography.label, { color: colors.textSecondary, marginTop: spacing.xl }]}>
          {t('profile.about')}
        </Text>
        <MenuItem label={t('profile.privacy')} onPress={() => {}} colors={colors} />
        <MenuItem label={t('profile.terms')} onPress={() => {}} colors={colors} />

        {/* Account */}
        <Text style={[typography.label, { color: colors.textSecondary, marginTop: spacing.xl }]}>
          {t('profile.account')}
        </Text>
        <MenuItem label={t('auth.logout')} onPress={handleLogout} colors={colors} danger />
        <MenuItem label={t('auth.deleteAccount')} onPress={handleDeleteAccount} colors={colors} danger />
      </ScrollView>
    </SafeAreaView>
  );
}

function MenuItem({
  label,
  onPress,
  colors,
  danger,
}: {
  label: string;
  onPress: () => void;
  colors: ThemeColors;
  danger?: boolean;
}) {
  return (
    <Pressable
      style={[styles.menuItem, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}
      onPress={onPress}
    >
      <Text style={[typography.body, { color: danger ? colors.error : colors.text }]}>
        {label}
      </Text>
      <Text style={[typography.body, { color: colors.textTertiary }]}>{'›'}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  backButton: {
    width: 32,
    height: 32,
    justifyContent: 'center',
  },
  content: {
    padding: spacing.lg,
    paddingBottom: spacing.xxl * 2,
  },
  section: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    marginTop: spacing.md,
  },
  tierBadge: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
  },
  menuItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    marginTop: spacing.sm,
  },
  languageGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  langChip: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
    borderWidth: 1,
  },
});
