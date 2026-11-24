import React, { useEffect, useRef, useState } from 'react';
import {
  Linking,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useThemeColors, typography, spacing, radius } from '../../theme';
import { Icon } from '../../components/common/Icon';

interface Props {
  visible: boolean;
  onClose: () => void;
  /**
   * Called when the scanner produces a barcode (camera or manual input).
   * The caller closes us and opens the confirm sheet.
   */
  onScanned: (barcode: string) => void;
  /**
   * Called when the user explicitly wants to skip the scanner and add a
   * pantry item by hand. The confirm sheet opens with no prefill.
   */
  onManualEntry: () => void;
}

type Mode = 'camera' | 'manual';

// Supermarkt-Ware ist Barcode/EAN/UPC — kein QR. Bewusst eingeschränkt, sonst
// triggert der Scanner z.B. auf Werbe-QR-Codes auf der Verpackung.
const BARCODE_TYPES = ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128'] as const;

export function ScanPantryItemScreen({
  visible,
  onClose,
  onScanned,
  onManualEntry,
}: Props) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [mode, setMode] = useState<Mode>('camera');
  const [manualValue, setManualValue] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);
  const scanLockRef = useRef(false);

  // Reset state every time the modal re-opens so a fresh scan starts clean.
  useEffect(() => {
    if (visible) {
      scanLockRef.current = false;
      setMode('camera');
      setManualValue('');
      setManualError(null);
    }
  }, [visible]);

  const handleBarcodeScanned = ({ data }: { data: string }) => {
    if (scanLockRef.current) return;
    const trimmed = data.trim();
    if (!trimmed) return;
    scanLockRef.current = true;
    onScanned(trimmed);
  };

  const handleSubmitManual = () => {
    const trimmed = manualValue.trim();
    if (!trimmed) {
      setManualError(t('pantry.scan.missingBarcode'));
      return;
    }
    onScanned(trimmed);
  };

  const handleAskPermission = () => {
    void requestPermission().then((result) => {
      // If the user already permanently denied, requestPermission can't
      // re-prompt — send them to Settings.
      if (!result.granted && !result.canAskAgain) {
        void Linking.openSettings();
      }
    });
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        {/* Header */}
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
            {t('pantry.scan.title')}
          </Text>
          <Pressable
            onPress={() => setMode((m) => (m === 'camera' ? 'manual' : 'camera'))}
            hitSlop={8}
            style={styles.headerIconRight}
          >
            <Text style={[typography.button, { color: colors.primary }]}>
              {mode === 'camera' ? t('pantry.scan.manualEntry') : t('pantry.scan.title')}
            </Text>
          </Pressable>
        </View>

        {mode === 'manual' ? (
          <ManualEntry
            value={manualValue}
            error={manualError}
            colors={colors}
            t={t}
            onChange={(v) => {
              setManualValue(v);
              if (manualError) setManualError(null);
            }}
            onSubmit={handleSubmitManual}
            onSkipBarcode={onManualEntry}
          />
        ) : !permission ? (
          // Permission state hasn't loaded yet.
          <View style={styles.centerArea}>
            <Text style={[typography.body, { color: colors.textSecondary }]}>
              {t('common.loading')}
            </Text>
          </View>
        ) : !permission.granted ? (
          <PermissionGate
            colors={colors}
            t={t}
            canAskAgain={permission.canAskAgain}
            onGrant={handleAskPermission}
            onManual={() => setMode('manual')}
          />
        ) : (
          <View style={styles.cameraWrap}>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: [...BARCODE_TYPES] }}
              onBarcodeScanned={handleBarcodeScanned}
            />
            {/* Frame overlay */}
            <View style={styles.frameOverlay} pointerEvents="none">
              <View style={[styles.frame, { borderColor: colors.primary }]} />
            </View>
            <View style={[styles.hintBox, { backgroundColor: colors.overlay, bottom: insets.bottom + spacing.xl }]}>
              <Text style={[typography.bodySmall, { color: '#FFFFFF', textAlign: 'center' }]}>
                {t('pantry.scan.hint')}
              </Text>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

interface PermissionGateProps {
  colors: ReturnType<typeof useThemeColors>;
  t: (k: string, opts?: Record<string, unknown>) => string;
  canAskAgain: boolean;
  onGrant: () => void;
  onManual: () => void;
}

function PermissionGate({ colors, t, canAskAgain, onGrant, onManual }: PermissionGateProps) {
  return (
    <View style={styles.centerArea}>
      <View
        style={[
          styles.permissionCard,
          { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
        ]}
      >
        <Text style={[typography.h3, { color: colors.text, marginBottom: spacing.sm }]}>
          {t('pantry.scan.permissionTitle')}
        </Text>
        <Text style={[typography.body, { color: colors.textSecondary, marginBottom: spacing.lg }]}>
          {t('pantry.scan.permissionBody')}
        </Text>
        <Pressable
          style={[styles.primaryButton, { backgroundColor: colors.primary }]}
          onPress={onGrant}
        >
          <Text style={[typography.button, { color: '#FFFFFF' }]}>
            {canAskAgain ? t('pantry.scan.grantPermission') : t('pantry.scan.grantPermission')}
          </Text>
        </Pressable>
        <Pressable style={styles.secondaryButton} onPress={onManual}>
          <Text style={[typography.button, { color: colors.primary }]}>
            {t('pantry.scan.manualEntry')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

interface ManualEntryProps {
  value: string;
  error: string | null;
  colors: ReturnType<typeof useThemeColors>;
  t: (k: string, opts?: Record<string, unknown>) => string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onSkipBarcode: () => void;
}

function ManualEntry({
  value,
  error,
  colors,
  t,
  onChange,
  onSubmit,
  onSkipBarcode,
}: ManualEntryProps) {
  return (
    <View style={styles.manualWrap}>
      <Text style={[typography.bodySmall, { color: colors.textSecondary, marginBottom: spacing.sm }]}>
        {t('pantry.scan.enterBarcode')}
      </Text>
      <TextInput
        style={[
          styles.manualInput,
          {
            backgroundColor: colors.surface,
            borderColor: error ? colors.error : colors.border,
            color: colors.text,
          },
        ]}
        placeholder={t('pantry.scan.enterBarcodePlaceholder')}
        placeholderTextColor={colors.textTertiary}
        value={value}
        onChangeText={onChange}
        keyboardType="number-pad"
        autoFocus
        returnKeyType="done"
        onSubmitEditing={onSubmit}
      />
      {error && (
        <Text style={[typography.caption, { color: colors.error, marginTop: spacing.xs }]}>
          {error}
        </Text>
      )}
      <Pressable
        style={[styles.primaryButton, { backgroundColor: colors.primary, marginTop: spacing.lg }]}
        onPress={onSubmit}
      >
        <Text style={[typography.button, { color: '#FFFFFF' }]}>{t('common.continue')}</Text>
      </Pressable>
      <Pressable style={styles.secondaryButton} onPress={onSkipBarcode}>
        <Text style={[typography.button, { color: colors.primary }]}>
          {t('pantry.addManually')}
        </Text>
      </Pressable>
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
  headerIconLeft: { width: 44, height: 44, justifyContent: 'center', alignItems: 'flex-start' },
  headerIconRight: { height: 44, justifyContent: 'center', alignItems: 'flex-end' },
  centerArea: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
  },
  permissionCard: {
    width: '100%',
    maxWidth: 360,
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  primaryButton: {
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  secondaryButton: {
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  cameraWrap: { flex: 1, position: 'relative' },
  frameOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },
  frame: {
    width: '78%',
    aspectRatio: 1.6,
    maxHeight: 220,
    borderWidth: 2,
    borderRadius: radius.lg,
  },
  hintBox: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
  },
  manualWrap: {
    padding: spacing.lg,
  },
  manualInput: {
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    fontSize: 16,
  },
});
