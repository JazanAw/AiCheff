import React, { useMemo, useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useThemeColors, typography, spacing, radius } from '../../theme';
import type { ThemeColors } from '../../theme';
import { COUNTRIES, type Country } from '../../data/countries';

interface Props {
  value: Country;
  onChange: (country: Country) => void;
}

export function CountryCodePicker({ value, onChange }: Props) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return COUNTRIES;
    return COUNTRIES.filter((c) => {
      return (
        c.name.toLowerCase().includes(q) ||
        c.dialCode.includes(q) ||
        c.code.toLowerCase().includes(q)
      );
    });
  }, [search]);

  const close = () => {
    setOpen(false);
    setSearch('');
  };

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={[
          styles.trigger,
          { backgroundColor: colors.surface, borderColor: colors.border },
        ]}
      >
        <Text style={styles.flag}>{value.flag}</Text>
        <Text style={[styles.dialCode, { color: colors.text }]}>{value.dialCode}</Text>
        <Text style={[styles.chevron, { color: colors.textSecondary }]}>▾</Text>
      </Pressable>

      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={close}
      >
        <SafeAreaView style={[styles.modal, { backgroundColor: colors.background }]}>
          <View style={[styles.header, { borderBottomColor: colors.borderLight }]}>
            <Pressable onPress={close} hitSlop={12}>
              <Text style={[typography.button, { color: colors.primary }]}>
                {t('common.cancel')}
              </Text>
            </Pressable>
            <Text style={[typography.h3, { color: colors.text }]}>
              {t('auth.signupForm.countryPicker.title')}
            </Text>
            <View style={{ width: 60 }} />
          </View>

          <View style={styles.searchWrap}>
            <TextInput
              autoFocus
              value={search}
              onChangeText={setSearch}
              placeholder={t('auth.signupForm.countryPicker.search')}
              placeholderTextColor={colors.textTertiary}
              style={[
                styles.search,
                { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text },
              ]}
            />
          </View>

          <FlatList
            data={filtered}
            keyExtractor={(item) => item.code}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <CountryRow
                country={item}
                selected={item.code === value.code}
                colors={colors}
                onPress={() => {
                  onChange(item);
                  close();
                }}
              />
            )}
            ListEmptyComponent={
              <Text
                style={[
                  typography.body,
                  { color: colors.textSecondary, textAlign: 'center', padding: spacing.xl },
                ]}
              >
                {t('common.noResults')}
              </Text>
            }
          />
        </SafeAreaView>
      </Modal>
    </>
  );
}

function CountryRow({
  country,
  selected,
  colors,
  onPress,
}: {
  country: Country;
  selected: boolean;
  colors: ThemeColors;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.row,
        {
          borderBottomColor: colors.borderLight,
          backgroundColor: selected ? colors.primaryLight : 'transparent',
        },
      ]}
    >
      <Text style={styles.rowFlag}>{country.flag}</Text>
      <Text style={[styles.rowName, { color: colors.text }]} numberOfLines={1}>
        {country.name}
      </Text>
      <Text style={[styles.rowDial, { color: colors.textSecondary }]}>
        {country.dialCode}
      </Text>
      {selected && (
        <Text style={[styles.check, { color: colors.primary }]}>✓</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: 6,
  },
  flag: { fontSize: 20 },
  dialCode: { fontSize: 16, fontWeight: '600' },
  chevron: { fontSize: 12, marginLeft: 2 },

  modal: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
  },
  searchWrap: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  search: {
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    fontSize: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    gap: spacing.md,
  },
  rowFlag: { fontSize: 24 },
  rowName: { flex: 1, fontSize: 16 },
  rowDial: { fontSize: 14, minWidth: 50, textAlign: 'right' },
  check: { fontSize: 18, fontWeight: '700', marginLeft: spacing.sm },
});
