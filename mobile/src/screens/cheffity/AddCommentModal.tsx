import React, { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
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

interface Props {
  visible: boolean;
  recipeName: string;
  onClose: () => void;
  onSubmit: (rating: number, text: string) => Promise<void>;
}

const RATING_OPTIONS = [1, 2, 3, 4, 5];

export function AddCommentModal({ visible, recipeName, onClose, onSubmit }: Props) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const [rating, setRating] = useState(5);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setRating(5);
      setText('');
      setSubmitting(false);
      setError(null);
    }
  }, [visible]);

  const canSubmit = text.trim().length > 0 && rating > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(rating, text.trim());
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.flex}
        >
          <View style={[styles.header, { borderBottomColor: colors.borderLight }]}>
            <Pressable onPress={onClose} hitSlop={8} disabled={submitting}>
              <Text style={[typography.button, { color: colors.primary }]}>
                {t('common.cancel')}
              </Text>
            </Pressable>
            <Text style={[typography.h3, { color: colors.text }]} numberOfLines={1}>
              {t('cheffity.detail.addComment')}
            </Text>
            <Pressable onPress={handleSubmit} hitSlop={8} disabled={!canSubmit}>
              <Text
                style={[
                  typography.button,
                  { color: canSubmit ? colors.primary : colors.textTertiary },
                ]}
              >
                {submitting ? '...' : t('common.save')}
              </Text>
            </Pressable>
          </View>

          <View style={styles.content}>
            <Text
              style={[
                typography.bodySmall,
                { color: colors.textSecondary, marginBottom: spacing.xs },
              ]}
              numberOfLines={2}
            >
              {recipeName}
            </Text>

            <Text
              style={[typography.label, { color: colors.textSecondary, marginTop: spacing.lg }]}
            >
              {t('cheffity.detail.ratingLabel')}
            </Text>
            <RatingPicker value={rating} onChange={setRating} colors={colors} />

            <Text
              style={[
                typography.label,
                { color: colors.textSecondary, marginTop: spacing.lg, marginBottom: spacing.xs },
              ]}
            >
              {t('cheffity.detail.commentTextLabel')}
            </Text>
            <TextInput
              style={[
                styles.textArea,
                {
                  backgroundColor: colors.surface,
                  borderColor: colors.border,
                  color: colors.text,
                },
              ]}
              value={text}
              onChangeText={setText}
              placeholder={t('cheffity.detail.commentTextPlaceholder')}
              placeholderTextColor={colors.textTertiary}
              multiline
              numberOfLines={6}
              maxLength={1000}
              autoFocus
            />

            {error && (
              <View
                style={[
                  styles.errorBox,
                  { backgroundColor: colors.errorLight, borderColor: colors.error },
                ]}
              >
                <Text style={[typography.bodySmall, { color: colors.error }]}>
                  {error}
                </Text>
              </View>
            )}
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

function RatingPicker({
  value,
  onChange,
  colors,
}: {
  value: number;
  onChange: (v: number) => void;
  colors: ThemeColors;
}) {
  return (
    <View style={styles.ratingRow}>
      {RATING_OPTIONS.map((star) => {
        const active = value >= star;
        return (
          <Pressable
            key={star}
            onPress={() => onChange(star)}
            hitSlop={4}
            style={styles.starButton}
          >
            <Text
              style={[
                styles.starText,
                { color: active ? '#FFC857' : colors.borderLight },
              ]}
            >
              {active ? '★' : '☆'}
            </Text>
          </Pressable>
        );
      })}
      <Text
        style={[
          typography.body,
          { color: colors.textSecondary, marginLeft: spacing.md },
        ]}
      >
        {value}/5
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
  },
  content: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  starButton: {
    paddingHorizontal: 2,
  },
  starText: {
    fontSize: 36,
  },
  textArea: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    fontSize: 16,
    minHeight: 140,
    textAlignVertical: 'top',
  },
  errorBox: {
    marginTop: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
});
