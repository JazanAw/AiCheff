import React, { useState } from 'react';
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

type Nav = NativeStackNavigationProp<AuthStackParamList, 'ForgotPassword'>;
type Route = NativeStackScreenProps<AuthStackParamList, 'ForgotPassword'>['route'];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function translateAuthError(error: unknown, t: (k: string) => string): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes('rate limit') || lower.includes('too many requests')) {
    return t('auth.errors.tooManyRequests');
  }
  if (lower.includes('network') || lower.includes('failed to fetch')) {
    return t('auth.errors.networkError');
  }
  return `${t('auth.errors.generic')}: ${message}`;
}

export function ForgotPasswordScreen() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const navigation = useNavigation<Nav>();
  const route = useRoute<Route>();
  const { requestPasswordReset } = useAuth();

  const [email, setEmail] = useState(route.params?.email ?? '');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onEmailChange = (value: string) => {
    setEmail(value);
    if (error) setError(null);
  };

  const handleSubmit = async () => {
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setError(t('auth.signupForm.invalidEmail'));
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await requestPasswordReset(trimmed);
      navigation.navigate('ResetPassword', { email: trimmed });
    } catch (e) {
      setError(translateAuthError(e, t));
    } finally {
      setSubmitting(false);
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
            {t('auth.forgotPassword.title')}
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
            {t('auth.forgotPassword.subtitle')}
          </Text>

          <Text style={[typography.bodySmall, { color: colors.textSecondary, marginBottom: 6 }]}>
            {t('auth.email')}
          </Text>
          <TextInput
            style={[
              styles.input,
              { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text },
            ]}
            value={email}
            onChangeText={onEmailChange}
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
            placeholder="email@example.com"
            placeholderTextColor={colors.textTertiary}
            autoFocus={!email}
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

          <Pressable
            style={[
              styles.submitButton,
              { backgroundColor: colors.primary, opacity: submitting ? 0.6 : 1 },
            ]}
            onPress={handleSubmit}
            disabled={submitting}
          >
            <Text style={[typography.button, { color: '#FFFFFF' }]}>
              {submitting ? '...' : t('auth.forgotPassword.submit')}
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
  input: {
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    fontSize: 16,
  },
  errorBox: {
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
});
