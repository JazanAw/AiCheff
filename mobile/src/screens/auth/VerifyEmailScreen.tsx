import React, { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import { useThemeColors, typography, spacing, radius } from '../../theme';
import { useAuth } from '../../store/AuthContext';
import type { AuthStackParamList } from '../../navigation/AuthNavigator';

type Nav = NativeStackNavigationProp<AuthStackParamList, 'VerifyEmail'>;
type Props = NativeStackScreenProps<AuthStackParamList, 'VerifyEmail'>;

const COOLDOWN_SECONDS = 60;

function translateOtpError(error: unknown, t: (k: string) => string): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes('expired')) {
    return t('auth.verify.codeExpired');
  }
  if (
    lower.includes('invalid') ||
    lower.includes('token has expired or is invalid') ||
    lower.includes('otp')
  ) {
    return t('auth.verify.invalidCode');
  }
  if (lower.includes('rate limit') || lower.includes('too many')) {
    return t('auth.errors.tooManyRequests');
  }
  return `${t('auth.errors.generic')}: ${message}`;
}

export function VerifyEmailScreen() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const navigation = useNavigation<Nav>();
  const route = useRoute<Props['route']>();
  const { email } = route.params;
  const { verifyEmailOtp, resendEmailOtp } = useAuth();

  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cooldown, setCooldown] = useState(COOLDOWN_SECONDS);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setInterval(() => {
      setCooldown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(id);
  }, [cooldown]);

  const onCodeChange = (value: string) => {
    const cleaned = value.replace(/\D/g, '').slice(0, 6);
    setCode(cleaned);
    if (error) setError(null);
    if (info) setInfo(null);
  };

  const handleVerify = async () => {
    if (code.length !== 6) return;
    setError(null);
    setInfo(null);
    setSubmitting(true);
    try {
      await verifyEmailOtp(email, code);
      // On success the AuthContext will pick up the new session and the
      // RootNavigator will switch to the onboarding flow. Nothing else to do.
    } catch (e) {
      setError(translateOtpError(e, t));
    } finally {
      setSubmitting(false);
    }
  };

  const handleResend = async () => {
    if (cooldown > 0) return;
    setError(null);
    setInfo(null);
    try {
      await resendEmailOtp(email);
      setInfo(t('auth.verify.resentSuccess'));
      setCooldown(COOLDOWN_SECONDS);
    } catch (e) {
      setError(translateOtpError(e, t));
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <View style={styles.header}>
          <Pressable onPress={() => navigation.goBack()} hitSlop={12}>
            <Text style={[typography.button, { color: colors.primary }]}>
              ‹ {t('common.back')}
            </Text>
          </Pressable>
        </View>

        <View style={styles.content}>
          <Text style={[typography.h1, { color: colors.text, textAlign: 'center' }]}>
            {t('auth.verify.email.title')}
          </Text>
          <Text
            style={[
              typography.body,
              {
                color: colors.textSecondary,
                textAlign: 'center',
                marginTop: spacing.sm,
                marginBottom: spacing.xl,
              },
            ]}
          >
            {t('auth.verify.email.subtitle', { email })}
          </Text>

          <TextInput
            ref={inputRef}
            style={[
              styles.codeInput,
              { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text },
            ]}
            placeholder={t('auth.verify.email.codePlaceholder')}
            placeholderTextColor={colors.textTertiary}
            value={code}
            onChangeText={onCodeChange}
            keyboardType="number-pad"
            inputMode="numeric"
            maxLength={6}
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            returnKeyType="done"
            onSubmitEditing={handleVerify}
          />

          {error && (
            <View
              style={[
                styles.errorBox,
                { backgroundColor: colors.errorLight, borderColor: colors.error },
              ]}
            >
              <Text style={[typography.bodySmall, { color: colors.error, textAlign: 'center' }]}>
                {error}
              </Text>
            </View>
          )}

          {info && (
            <View
              style={[
                styles.infoBox,
                { backgroundColor: colors.accentLight, borderColor: colors.accent },
              ]}
            >
              <Text style={[typography.bodySmall, { color: colors.accent, textAlign: 'center' }]}>
                {info}
              </Text>
            </View>
          )}

          <Pressable
            style={[
              styles.submitButton,
              {
                backgroundColor: colors.primary,
                opacity: submitting || code.length !== 6 ? 0.6 : 1,
              },
            ]}
            onPress={handleVerify}
            disabled={submitting || code.length !== 6}
          >
            <Text style={[typography.button, { color: '#FFFFFF' }]}>
              {submitting ? '...' : t('auth.verify.email.submit')}
            </Text>
          </Pressable>

          <Pressable
            onPress={handleResend}
            disabled={cooldown > 0}
            style={styles.resendRow}
            hitSlop={8}
          >
            <Text
              style={[
                typography.bodySmall,
                {
                  color: cooldown > 0 ? colors.textTertiary : colors.primary,
                  textAlign: 'center',
                },
              ]}
            >
              {cooldown > 0
                ? t('auth.verify.resendIn', { seconds: cooldown })
                : t('auth.verify.resend')}
            </Text>
          </Pressable>

          <Pressable
            onPress={() => navigation.goBack()}
            style={styles.changeEmailRow}
            hitSlop={8}
          >
            <Text style={[typography.bodySmall, { color: colors.textSecondary, textAlign: 'center' }]}>
              {t('auth.verify.changeEmail')}
            </Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  header: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
  },
  content: {
    flex: 1,
    paddingHorizontal: spacing.xl,
    justifyContent: 'center',
  },
  codeInput: {
    paddingVertical: 18,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    fontSize: 28,
    fontWeight: '600',
    letterSpacing: 8,
    textAlign: 'center',
  },
  errorBox: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    marginTop: spacing.md,
  },
  infoBox: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    marginTop: spacing.md,
  },
  submitButton: {
    paddingVertical: 16,
    borderRadius: radius.md,
    alignItems: 'center',
    marginTop: spacing.lg,
  },
  resendRow: {
    paddingVertical: spacing.md,
  },
  changeEmailRow: {
    paddingVertical: spacing.sm,
  },
});
