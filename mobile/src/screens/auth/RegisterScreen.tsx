import React, { useState } from 'react';
import {
  Image,
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
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useThemeColors, typography, spacing, radius } from '../../theme';
import { useAuth } from '../../store/AuthContext';
import { CountryCodePicker } from '../../components/common/CountryCodePicker';
import { DEFAULT_COUNTRY, type Country } from '../../data/countries';
import type { AuthStackParamList } from '../../navigation/AuthNavigator';

type Nav = NativeStackNavigationProp<AuthStackParamList, 'Register'>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function translateAuthError(error: unknown, t: (k: string) => string): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes('user already registered') || lower.includes('already_registered')) {
    return t('auth.errors.userAlreadyRegistered');
  }
  if (lower.includes('weak password') || lower.includes('password should be at least')) {
    return t('auth.errors.weakPassword');
  }
  if (lower.includes('rate limit') || lower.includes('too many requests')) {
    return t('auth.errors.tooManyRequests');
  }
  if (lower.includes('network') || lower.includes('failed to fetch')) {
    return t('auth.errors.networkError');
  }
  return `${t('auth.errors.generic')}: ${message}`;
}

export function RegisterScreen() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const navigation = useNavigation<Nav>();
  const { signUpWithEmail } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [country, setCountry] = useState<Country>(DEFAULT_COUNTRY);
  const [phoneDigits, setPhoneDigits] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const clearErrorOn = (setter: (v: string) => void) => (v: string) => {
    setter(v);
    if (error) setError(null);
  };
  const onPhoneDigitsChange = (v: string) => {
    setPhoneDigits(v.replace(/\D/g, ''));
    if (error) setError(null);
  };
  const onCountryChange = (c: Country) => {
    setCountry(c);
    if (error) setError(null);
  };

  const validate = (): string | null => {
    if (!EMAIL_RE.test(email.trim())) return t('auth.signupForm.invalidEmail');
    if (password.length < 6)          return t('auth.signupForm.passwordTooShort');
    if (password !== passwordConfirm) return t('auth.signupForm.passwordMismatch');
    if (phoneDigits && phoneDigits.length < 4) {
      return t('auth.signupForm.invalidPhone');
    }
    return null;
  };

  const handleSubmit = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const fullPhone = phoneDigits ? `${country.dialCode}${phoneDigits}` : undefined;
      const result = await signUpWithEmail({
        email: email.trim(),
        password,
        phone: fullPhone,
      });

      if (result.alreadyRegistered) {
        navigation.navigate('Login', {
          email: email.trim(),
          flashMessage: t('auth.alreadyRegisteredFlash'),
        });
        return;
      }

      if (result.needsEmailVerification) {
        navigation.navigate('VerifyEmail', { email: email.trim() });
      }
      // If session is already active (auto-confirm), AuthContext picks it up,
      // RootNavigator switches to OnboardingNavigator automatically.
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
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <Pressable onPress={() => navigation.goBack()} hitSlop={12}>
              <Text style={[typography.button, { color: colors.primary }]}>
                ‹ {t('common.back')}
              </Text>
            </Pressable>
          </View>

          <Image
            source={require('../../../assets/icon.png')}
            style={styles.logo}
            resizeMode="contain"
          />

          <Text style={[typography.h1, { color: colors.text, textAlign: 'center' }]}>
            {t('auth.signupForm.title')}
          </Text>
          <Text
            style={[
              typography.body,
              { color: colors.textSecondary, textAlign: 'center', marginTop: spacing.sm, marginBottom: spacing.xl },
            ]}
          >
            {t('auth.signupForm.subtitle')}
          </Text>

          <View style={styles.form}>
            <Field
              label={t('auth.email')}
              value={email}
              onChangeText={clearErrorOn(setEmail)}
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              colors={colors}
            />

            <Field
              label={t('auth.password')}
              value={password}
              onChangeText={clearErrorOn(setPassword)}
              secureTextEntry
              autoComplete="new-password"
              colors={colors}
            />

            <Field
              label={t('auth.signupForm.passwordConfirm')}
              value={passwordConfirm}
              onChangeText={clearErrorOn(setPasswordConfirm)}
              secureTextEntry
              autoComplete="new-password"
              colors={colors}
            />

            <View style={styles.field}>
              <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>
                {`${t('auth.signupForm.phone')} (${t('auth.signupForm.phoneOptional')})`}
              </Text>
              <View style={styles.phoneRow}>
                <CountryCodePicker value={country} onChange={onCountryChange} />
                <TextInput
                  style={[
                    styles.input,
                    styles.phoneInput,
                    { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text },
                  ]}
                  value={phoneDigits}
                  onChangeText={onPhoneDigitsChange}
                  keyboardType="phone-pad"
                  autoComplete="tel"
                  placeholder={t('auth.signupForm.phoneDigitsPlaceholder')}
                  placeholderTextColor={colors.textTertiary}
                />
              </View>
              <Text style={[typography.caption, { color: colors.textTertiary }]}>
                {t('auth.signupForm.phoneHelper')}
              </Text>
            </View>

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
                {submitting ? '...' : t('auth.signupForm.submit')}
              </Text>
            </Pressable>

            <Pressable
              onPress={() => navigation.navigate('Login')}
              style={styles.linkRow}
            >
              <Text style={[typography.bodySmall, { color: colors.primary, textAlign: 'center' }]}>
                {t('auth.signupForm.haveAccount')}
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

interface FieldProps {
  label: string;
  helper?: string;
  value: string;
  onChangeText: (v: string) => void;
  secureTextEntry?: boolean;
  keyboardType?: 'default' | 'email-address' | 'phone-pad' | 'number-pad';
  autoCapitalize?: 'none' | 'sentences';
  autoComplete?: 'email' | 'new-password' | 'tel';
  colors: ReturnType<typeof useThemeColors>;
}

function Field({
  label,
  helper,
  value,
  onChangeText,
  secureTextEntry,
  keyboardType,
  autoCapitalize,
  autoComplete,
  colors,
}: FieldProps) {
  return (
    <View style={styles.field}>
      <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>
        {label}
      </Text>
      <TextInput
        style={[
          styles.input,
          { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text },
        ]}
        value={value}
        onChangeText={onChangeText}
        secureTextEntry={secureTextEntry}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize ?? 'none'}
        autoComplete={autoComplete}
      />
      {helper && (
        <Text style={[typography.caption, { color: colors.textTertiary }]}>
          {helper}
        </Text>
      )}
    </View>
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
  logo: {
    width: 72,
    height: 72,
    alignSelf: 'center',
    marginBottom: spacing.md,
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
  phoneRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'stretch',
  },
  phoneInput: {
    flex: 1,
  },
  errorBox: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    marginTop: spacing.xs,
  },
  submitButton: {
    paddingVertical: 16,
    borderRadius: radius.md,
    alignItems: 'center',
    marginTop: spacing.md,
  },
  linkRow: {
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
});
