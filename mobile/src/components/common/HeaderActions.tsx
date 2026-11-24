import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useNavigation, NavigationProp } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { useThemeColors, spacing } from '../../theme';
import { Icon } from './Icon';

type Nav = NavigationProp<Record<string, object | undefined>>;

interface Props {
  /** Icon tint. Defaults to the theme text color; pass a light color over dark screens. */
  color?: string;
  size?: number;
}

/**
 * The two top-right "tools/account" actions shared by every main tab screen:
 *   1. Einkauf & Lager (InventoryHub — shopping list + pantry)
 *   2. Profil
 *
 * Both targets live on the app-level stack (see MainTabNavigator), so the
 * navigate calls bubble up from whichever tab renders this component.
 */
export function HeaderActions({ color, size = 22 }: Props) {
  const navigation = useNavigation<Nav>();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const tint = color ?? colors.text;

  return (
    <View style={styles.row}>
      <Pressable
        onPress={() => navigation.navigate('InventoryHub')}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={t('header.inventory')}
        style={styles.button}
      >
        <Icon name="cart" size={size} color={tint} />
      </Pressable>
      <Pressable
        onPress={() => navigation.navigate('Profile')}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={t('header.profile')}
        style={styles.button}
      >
        <Icon name="profile" size={size} color={tint} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  button: { padding: spacing.xs },
});
