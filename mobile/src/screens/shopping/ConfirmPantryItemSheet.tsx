import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useThemeColors, typography, spacing, radius } from '../../theme';
import { Icon } from '../../components/common/Icon';
import {
  addPantryItem,
  findActivePantryItemByBarcode,
  incrementPantryItemQuantity,
} from '../../services/pantryApi';
import {
  lookupProductByBarcode,
  type ProductLookupResult,
} from '../../services/productLookupApi';
import type { PantryItem } from '../../types';

interface Props {
  visible: boolean;
  /** Pre-scanned barcode. null/empty = pure manual entry. */
  barcode: string | null;
  locale: string;
  onClose: () => void;
  /** Called after a successful save so the parent can refresh its list. */
  onSaved: () => void;
}

type SaveMode = 'new' | 'increment';

interface FormState {
  productName: string;
  brand: string;
  category: string;
  quantity: string;
  unit: string;
}

const EMPTY_FORM: FormState = {
  productName: '',
  brand: '',
  category: '',
  quantity: '1',
  unit: '',
};

export function ConfirmPantryItemSheet({
  visible,
  barcode,
  locale,
  onClose,
  onSaved,
}: Props) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();

  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupResult, setLookupResult] = useState<ProductLookupResult | null>(null);
  const [lookupBanner, setLookupBanner] = useState<'failed' | 'error' | null>(null);
  const [existing, setExisting] = useState<PantryItem | null>(null);
  const [saveMode, setSaveMode] = useState<SaveMode>('new');
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Reset whenever the sheet is reopened. Triggers lookup if a barcode is
  // present, otherwise drops into pure-manual mode.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLookupResult(null);
    setLookupBanner(null);
    setExisting(null);
    setSaveMode('new');
    setForm(EMPTY_FORM);
    setSaveError(null);

    const trimmed = (barcode ?? '').trim();
    if (!trimmed) {
      return () => {
        cancelled = true;
      };
    }

    setLookupLoading(true);
    Promise.all([
      lookupProductByBarcode(trimmed, locale).catch((error) => {
        if (cancelled) return null;
        console.warn('[ConfirmPantryItemSheet] OFF lookup failed:', (error as Error).message);
        setLookupBanner('error');
        return null;
      }),
      findActivePantryItemByBarcode(trimmed).catch((error) => {
        if (cancelled) return null;
        console.warn('[ConfirmPantryItemSheet] pantry lookup failed:', (error as Error).message);
        return null;
      }),
    ])
      .then(([lookup, existingRow]) => {
        if (cancelled) return;
        if (lookup) {
          setLookupResult(lookup);
        } else if (lookupBanner !== 'error') {
          setLookupBanner('failed');
        }
        setForm(buildForm(lookup, existingRow));
        if (existingRow) {
          setExisting(existingRow);
          setSaveMode('increment');
        }
      })
      .finally(() => {
        if (!cancelled) setLookupLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // lookupBanner intentionally NOT a dep — referenced inside the .then for
    // a status check that should reflect what the lookup itself just set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, barcode, locale]);

  const imageUrl = lookupResult?.imageUrl;
  const showExistingBanner = existing != null;

  const updateForm = (patch: Partial<FormState>) => setForm((prev) => ({ ...prev, ...patch }));

  const handleSave = async () => {
    const trimmedName = form.productName.trim();
    const trimmedBarcode = (barcode ?? '').trim();
    const parsedQty = Number(form.quantity.replace(',', '.'));
    if (!Number.isFinite(parsedQty) || parsedQty <= 0) {
      setSaveError(t('pantry.scan.error'));
      return;
    }

    if (saveMode === 'increment' && existing) {
      setSaveError(null);
      setSaving(true);
      try {
        await incrementPantryItemQuantity(existing.id, parsedQty);
        onSaved();
      } catch (error) {
        setSaveError((error as Error).message || t('pantry.scan.error'));
      } finally {
        setSaving(false);
      }
      return;
    }

    // New-item path needs at least a name.
    if (!trimmedName) {
      setSaveError(t('pantry.scan.missingName'));
      return;
    }

    setSaveError(null);
    setSaving(true);
    try {
      await addPantryItem({
        name: trimmedName,
        quantity: parsedQty,
        unit: form.unit.trim(),
        barcode: trimmedBarcode || undefined,
        brand: form.brand.trim() || undefined,
        productName: trimmedName,
        category: form.category.trim() || undefined,
        imageUrl: lookupResult?.imageUrl,
        nutrition: lookupResult?.nutrition,
        ingredientsText: lookupResult?.ingredientsText,
        rawProductPayload: lookupResult?.rawProductPayload,
        lookupSource: lookupResult ? 'openfoodfacts' : 'manual',
      });
      onSaved();
    } catch (error) {
      setSaveError((error as Error).message || t('pantry.scan.error'));
    } finally {
      setSaving(false);
    }
  };

  const saveLabel = useMemo(() => {
    if (saving) return t('pantry.scan.saving');
    if (saveMode === 'increment') return t('pantry.scan.increaseQuantity');
    return t('pantry.scan.save');
  }, [saving, saveMode, t]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={[styles.container, { backgroundColor: colors.background }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View
          style={[
            styles.header,
            {
              backgroundColor: colors.background,
              borderBottomColor: colors.borderLight,
              paddingTop: insets.top + spacing.sm,
            },
          ]}
        >
          <Pressable onPress={onClose} hitSlop={8} style={styles.headerIconLeft}>
            <Icon name="close" size={22} color={colors.text} />
          </Pressable>
          <Text style={[typography.h3, { color: colors.text, flex: 1, textAlign: 'center' }]}>
            {t('pantry.scan.confirmTitle')}
          </Text>
          <View style={styles.headerIconLeft} />
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {lookupLoading && (
            <View style={[styles.loadingRow, { borderColor: colors.borderLight }]}>
              <ActivityIndicator color={colors.primary} />
              <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>
                {t('pantry.scan.lookingUp')}
              </Text>
            </View>
          )}

          {!lookupLoading && lookupBanner === 'failed' && (
            <Banner
              tone="warning"
              text={t('pantry.scan.lookupFailed')}
              colors={colors}
            />
          )}
          {!lookupLoading && lookupBanner === 'error' && (
            <Banner tone="error" text={t('pantry.scan.lookupError')} colors={colors} />
          )}

          {showExistingBanner && existing && (
            <ExistingBanner
              existing={existing}
              mode={saveMode}
              onModeChange={setSaveMode}
              colors={colors}
              t={t}
            />
          )}

          {imageUrl ? (
            <View style={styles.imageWrap}>
              <Image source={{ uri: imageUrl }} style={styles.image} />
            </View>
          ) : null}

          <Field label={t('pantry.scan.productName')} colors={colors}>
            <TextInput
              style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
              value={form.productName}
              onChangeText={(v) => updateForm({ productName: v })}
              placeholder={t('pantry.scan.productNamePlaceholder')}
              placeholderTextColor={colors.textTertiary}
              editable={saveMode === 'new'}
            />
          </Field>

          <Field label={t('pantry.scan.brand')} colors={colors}>
            <TextInput
              style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
              value={form.brand}
              onChangeText={(v) => updateForm({ brand: v })}
              placeholder={t('pantry.scan.brandPlaceholder')}
              placeholderTextColor={colors.textTertiary}
              editable={saveMode === 'new'}
            />
          </Field>

          <View style={styles.row}>
            <Field label={t('pantry.scan.quantity')} colors={colors} style={styles.rowItem}>
              <TextInput
                style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
                value={form.quantity}
                onChangeText={(v) => updateForm({ quantity: v })}
                keyboardType="decimal-pad"
              />
            </Field>
            <Field label={t('pantry.scan.unit')} colors={colors} style={styles.rowItem}>
              <TextInput
                style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
                value={form.unit}
                onChangeText={(v) => updateForm({ unit: v })}
                placeholder="g / ml / Stk"
                placeholderTextColor={colors.textTertiary}
                editable={saveMode === 'new'}
              />
            </Field>
          </View>

          {form.category ? (
            <Field label={t('pantry.scan.category')} colors={colors}>
              <Text style={[typography.body, { color: colors.textSecondary, paddingVertical: spacing.sm }]}>
                {form.category}
              </Text>
            </Field>
          ) : null}

          {barcode ? (
            <Field label={t('pantry.scan.barcode')} colors={colors}>
              <Text style={[typography.body, { color: colors.textSecondary, paddingVertical: spacing.sm }]}>
                {barcode}
              </Text>
            </Field>
          ) : null}

          {saveError && (
            <Banner tone="error" text={saveError} colors={colors} />
          )}
        </ScrollView>

        <View
          style={[
            styles.footer,
            {
              backgroundColor: colors.surfaceElevated,
              borderTopColor: colors.border,
              paddingBottom: insets.bottom + spacing.md,
            },
          ]}
        >
          <Pressable
            style={[styles.secondaryButton, { borderColor: colors.border }]}
            onPress={onClose}
            disabled={saving}
          >
            <Text style={[typography.button, { color: colors.text }]}>
              {t('pantry.scan.cancel')}
            </Text>
          </Pressable>
          <Pressable
            style={[
              styles.primaryButton,
              { backgroundColor: colors.primary, opacity: saving ? 0.6 : 1 },
            ]}
            onPress={handleSave}
            disabled={saving}
          >
            {saving ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={[typography.button, { color: '#FFFFFF' }]}>{saveLabel}</Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function buildForm(
  lookup: ProductLookupResult | null,
  existing: PantryItem | null,
): FormState {
  if (existing) {
    return {
      productName: existing.productName ?? existing.name,
      brand: existing.brand ?? '',
      category: existing.category ?? '',
      // Default delta = 1 for the increment flow; user can adjust.
      quantity: '1',
      unit: existing.unit ?? '',
    };
  }
  return {
    productName: lookup?.productName ?? '',
    brand: lookup?.brand ?? '',
    category: lookup?.category ?? '',
    quantity: '1',
    unit: '',
  };
}

interface FieldProps {
  label: string;
  colors: ReturnType<typeof useThemeColors>;
  style?: object;
  children: React.ReactNode;
}

function Field({ label, colors, style, children }: FieldProps) {
  return (
    <View style={[styles.field, style]}>
      <Text style={[typography.caption, { color: colors.textTertiary, marginBottom: spacing.xs }]}>
        {label.toUpperCase()}
      </Text>
      {children}
    </View>
  );
}

interface BannerProps {
  tone: 'warning' | 'error';
  text: string;
  colors: ReturnType<typeof useThemeColors>;
}

function Banner({ tone, text, colors }: BannerProps) {
  const bg = tone === 'error' ? colors.errorLight : colors.warningLight;
  const fg = tone === 'error' ? colors.error : colors.warning;
  return (
    <View style={[styles.banner, { backgroundColor: bg, borderColor: fg }]}>
      <Text style={[typography.bodySmall, { color: fg }]}>{text}</Text>
    </View>
  );
}

interface ExistingBannerProps {
  existing: PantryItem;
  mode: SaveMode;
  onModeChange: (m: SaveMode) => void;
  colors: ReturnType<typeof useThemeColors>;
  t: (k: string, opts?: Record<string, unknown>) => string;
}

function ExistingBanner({ existing, mode, onModeChange, colors, t }: ExistingBannerProps) {
  return (
    <View
      style={[
        styles.existingBanner,
        { backgroundColor: colors.primaryLight, borderColor: colors.primary },
      ]}
    >
      <Text style={[typography.bodySmall, { color: colors.primary, fontWeight: '700' }]}>
        {t('pantry.scan.productAlreadyExists')}
      </Text>
      <Text style={[typography.caption, { color: colors.text, marginTop: 2 }]}>
        {existing.quantity}
        {existing.unit ? ` ${existing.unit}` : 'x'} {existing.name}
      </Text>
      <View style={styles.existingButtonRow}>
        <Pressable
          style={[
            styles.modeButton,
            {
              backgroundColor: mode === 'increment' ? colors.primary : 'transparent',
              borderColor: colors.primary,
            },
          ]}
          onPress={() => onModeChange('increment')}
        >
          <Text
            style={[
              typography.buttonSmall,
              { color: mode === 'increment' ? '#FFFFFF' : colors.primary },
            ]}
          >
            {t('pantry.scan.increaseQuantity')}
          </Text>
        </Pressable>
        <Pressable
          style={[
            styles.modeButton,
            {
              backgroundColor: mode === 'new' ? colors.primary : 'transparent',
              borderColor: colors.primary,
            },
          ]}
          onPress={() => onModeChange('new')}
        >
          <Text
            style={[
              typography.buttonSmall,
              { color: mode === 'new' ? '#FFFFFF' : colors.primary },
            ]}
          >
            {t('pantry.scan.saveAsNew')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    gap: spacing.sm,
  },
  headerIconLeft: { width: 44, height: 44, justifyContent: 'center' },
  scroll: { flex: 1 },
  scrollContent: { padding: spacing.lg, gap: spacing.md },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  banner: {
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  existingBanner: {
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: spacing.sm,
  },
  existingButtonRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  modeButton: {
    flex: 1,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    alignItems: 'center',
  },
  imageWrap: { alignItems: 'center', paddingVertical: spacing.sm },
  image: {
    width: 120,
    height: 120,
    borderRadius: radius.md,
    resizeMode: 'contain',
  },
  field: { gap: 2 },
  input: {
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    fontSize: 16,
  },
  row: { flexDirection: 'row', gap: spacing.sm },
  rowItem: { flex: 1 },
  footer: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: 1,
  },
  secondaryButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
  },
  primaryButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
