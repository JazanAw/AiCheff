import React, { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
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

type Nav = NativeStackNavigationProp<AuthStackParamList, 'ResetPassword'>;
type Route = NativeStackScreenProps<AuthStackParamList, 'ResetPassword'>['route'];

const COOLDOWN_SECONDS = 60;

function translateOtpError(error: unknown, t: (k: string) => string): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes('expired')) return t('auth.verify.codeExpired');
  if (lower.includes('invalid') || lower.includes('otp')) return t('auth.verify.invalidCode');
  if (lower.includes('rate limit') || lower.includes('too many')) return t('auth.errors.tooManyRequests');
  if (lower.includes('weak password') || lower.includes('password should be at least')) {
    return t('auth.errors.weakPassword');
  }
  return `${t('auth.errors.generic')}: ${message}`;
}

export function ResetPasswordScreen() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const navigation = useNavigation<Nav>();
  const route = useRoute<Route>();
  const { email } = route.params;
  const { verifyResetOtp, updatePassword, requestPasswordReset } = useAuth();

  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPasswordConfirm, setNewPasswordConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cooldown, setCooldown] = useState(COOLDOWN_SECONDS);
  const codeInputRef = useRef<TextInput>(null);

  useEffect(() => {
    codeInputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setInterval(() => setCooldown((prev) => (prev > 0 ? prev - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [cooldown]);

  const onCodeChange = (value: string) => {
    setCode(value.replace(/\D/g, '').slice(0, 6));
    if (error) setError(null);
    if (info) setInfo(null);
  };
  const clearOn = (setter: (v: string) => void) => (v: string) => {
    setter(v);
    if (error) setError(null);
  };

  const validate = (): string | null => {
    if (code.length !== 6) return t('auth.verify.invalidCode');
    if (newPassword.length < 6) return t('auth.signupForm.passwordTooShort');
    if (newPassword !== newPasswordConfirm) return t('auth.signupForm.passwordMismatch');
    return null;
  };

  const handleSubmit = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setInfo(null);
    setSubmitting(true);
    try {
      await verifyResetOtp(email, code);
      await updatePassword(newPassword);
      // verifyResetOtp creates a session — AuthContext picks it up,
      // RootNavigator routes the user to onboarding/main automatically.
      // No further nav needed; show success briefly.
      setInfo(t('auth.resetPassword.success'));
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
      await requestPasswordReset(email);
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
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.header}>
            <Pressable onPress={() => navigation.goBack()} hitSlop={12}>
              <Text style={[typography.button, { color: colors.primary }]}>
                ‹ {t('common.back')}
              </Text>
            </Pressable>
          </View>

          <Text style={[typography.h1, { color: colors.text, textAlign: 'center' }]}>
            {t('auth.resetPassword.title')}
          </Text>
          <Text
            style={[
              typography.body,
              { color: colors.textSecondary, textAlign: 'center', marginTop: spacing.sm },
            ]}
          >
            {t('auth.forgotPassword.sentInfo', { email })}
          </Text>
          <Text
            style={[
              typography.bodySmall,
              { color: colors.textSecondary, textAlign: 'center', marginTop: spacing.xs, marginBottom: spacing.xl },
            ]}
          >
            {t('auth.resetPassword.subtitle')}
          </Text>

          <View style={styles.form}>
            <View style={styles.field}>
              <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>
                {t('auth.verify.email.codePlaceholder')}
              </Text>
              <TextInput
                ref={codeInputRef}
                style={[
                  styles.codeInput,
                  { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text },
                ]}
                value={code}
                onChangeText={onCodeChange}
                keyboardType="number-pad"
                inputMode="numeric"
                maxLength={6}
                autoComplete="one-time-code"
                textContentType="oneTimeCode"
                placeholder="000000"
                placeholderTextColor={colors.textTertiary}
              />
            </View>

            <View style={styles.field}>
              <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>
                {t('auth.resetPassword.newPassword')}
              </Text>
              <TextInput
                style={[
                  styles.input,
                  { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text },
                ]}
                value={newPassword}
                onChangeText={clearOn(setNewPassword)}
                secureTextEntry
                autoComplete="new-password"
              />
            </View>

            <View style={styles.field}>
              <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>
                {t('auth.resetPassword.newPasswordConfirm')}
              </Text>
              <TextInput
                style={[
                  styles.input,
                  { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text },
                ]}
                value={newPasswordConfirm}
                onChangeText={clearOn(setNewPasswordConfirm)}
                secureTextEntry
                autoComplete="new-password"
              />
            </View>

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

            <Pressable
              style={[
                styles.submitButton,
                { backgroundColor: colors.primary, opacity: submitting ? 0.6 : 1 },
              ]}
              onPress={handleSubmit}
              disabled={submitting}
            >
              <Text style={[typography.button, { color: '#FFFFFF' }]}>
                {submitting ? '...' : t('auth.resetPassword.submit')}
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
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  scroll: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xxl,
  },
  header: {
    paddingTop: spacing.sm,
    paddingBottom: spacing.lg,
  },
  form: { gap: spacing.md },
  field: { gap: 6 },
  input: {
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    fontSize: 16,
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
  },
  infoBox: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  submitButton: {
    paddingVertical: 16,
    borderRadius: radius.md,
    alignItems: 'center',
    marginTop: spacing.md,
  },
  resendRow: {
    paddingVertical: spacing.md,
  },
});
