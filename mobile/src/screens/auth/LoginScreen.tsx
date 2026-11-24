import React, { useEffect, useState } from 'react';
import {
  Alert,
  Image,
  Linking,
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
import * as Google from 'expo-auth-session/providers/google';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { useThemeColors, typography, spacing, radius } from '../../theme';
import { useAuth } from '../../store/AuthContext';
import { supabase } from '../../config/supabase';
import type { AuthStackParamList } from '../../navigation/AuthNavigator';

WebBrowser.maybeCompleteAuthSession();

type Nav = NativeStackNavigationProp<AuthStackParamList, 'Login'>;
type Route = NativeStackScreenProps<AuthStackParamList, 'Login'>['route'];

const PRIVACY_URL = 'https://cheffity.app/privacy';
const TERMS_URL = 'https://cheffity.app/terms';

function translateAuthError(error: unknown, t: (k: string) => string): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes('invalid login credentials') || lower.includes('invalid_credentials')) {
    return t('auth.errors.invalidCredentials');
  }
  if (lower.includes('email not confirmed') || lower.includes('email_not_confirmed')) {
    return t('auth.errors.emailNotConfirmed');
  }
  if (lower.includes('rate limit') || lower.includes('too many requests')) {
    return t('auth.errors.tooManyRequests');
  }
  if (lower.includes('network') || lower.includes('failed to fetch')) {
    return t('auth.errors.networkError');
  }
  return `${t('auth.errors.generic')}: ${message}`;
}

const GOOGLE_IOS_CLIENT_ID     = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
const GOOGLE_ANDROID_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID;
const GOOGLE_WEB_CLIENT_ID     = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;

// On web we use the useIdTokenAuthRequest hook (needs webClientId).
// On native we use Supabase's signInWithOAuth + WebBrowser, which only needs
// the Web Client ID configured server-side in Supabase — the env var is just
// a "configured" indicator.
const GOOGLE_AVAILABLE = Boolean(GOOGLE_WEB_CLIENT_ID);

function GoogleSignInButton({ loading }: { loading: boolean }) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { signInWithIdToken } = useAuth();
  const [, googleResponse, googlePromptAsync] = Google.useIdTokenAuthRequest({
    iosClientId:     GOOGLE_IOS_CLIENT_ID,
    androidClientId: GOOGLE_ANDROID_CLIENT_ID,
    webClientId:     GOOGLE_WEB_CLIENT_ID,
  });
  const [googleLoading, setGoogleLoading] = useState(false);

  useEffect(() => {
    if (googleResponse?.type !== 'success') return;
    const idToken = googleResponse.params?.id_token;
    if (!idToken) {
      Alert.alert(t('common.error'), 'Google did not return an ID token');
      return;
    }
    setGoogleLoading(true);
    signInWithIdToken('google', idToken)
      .catch((error) => Alert.alert(t('common.error'), (error as Error).message))
      .finally(() => setGoogleLoading(false));
  }, [googleResponse, signInWithIdToken, t]);

  const handleGoogle = async () => {
    try {
      await googlePromptAsync();
    } catch (error) {
      Alert.alert(t('common.error'), (error as Error).message);
    }
  };

  const disabled = loading || googleLoading;

  return (
    <Pressable
      style={[
        styles.oauthButton,
        { backgroundColor: colors.surface, borderColor: colors.border, opacity: disabled ? 0.6 : 1 },
      ]}
      onPress={handleGoogle}
      disabled={disabled}
    >
      <Text style={[typography.button, { color: colors.text }]}>
        {t('auth.continueWithGoogle')}
      </Text>
    </Pressable>
  );
}

function parseOAuthReturnParams(urlString: string): Record<string, string> {
  const out: Record<string, string> = {};
  const hashIndex = urlString.indexOf('#');
  const queryIndex = urlString.indexOf('?');
  const fragment = hashIndex >= 0 ? urlString.slice(hashIndex + 1) : '';
  const query = queryIndex >= 0
    ? urlString.slice(queryIndex + 1, hashIndex >= 0 ? hashIndex : undefined)
    : '';
  const eat = (segment: string) => {
    if (!segment) return;
    for (const pair of segment.split('&')) {
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const key = decodeURIComponent(pair.slice(0, eq));
      const val = decodeURIComponent(pair.slice(eq + 1));
      if (!(key in out)) out[key] = val;
    }
  };
  eat(fragment);
  eat(query);
  return out;
}

function NativeGoogleSignInButton({ loading }: { loading: boolean }) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const [submitting, setSubmitting] = useState(false);

  const handleGoogle = async () => {
    setSubmitting(true);
    try {
      const redirectTo = AuthSession.makeRedirectUri({ scheme: 'cheffity' });

      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo,
          skipBrowserRedirect: true,
        },
      });
      if (error) throw error;
      if (!data?.url) throw new Error('Supabase did not return an OAuth URL');

      const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);

      if (result.type === 'cancel' || result.type === 'dismiss') {
        return;
      }
      if (result.type !== 'success' || !result.url) {
        throw new Error(`OAuth flow returned ${result.type}`);
      }

      const params = parseOAuthReturnParams(result.url);

      if (params.error) {
        throw new Error(params.error_description || params.error);
      }
      if (params.access_token && params.refresh_token) {
        const { error: setError } = await supabase.auth.setSession({
          access_token: params.access_token,
          refresh_token: params.refresh_token,
        });
        if (setError) throw setError;
      } else if (params.code) {
        const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(params.code);
        if (exchangeError) throw exchangeError;
      } else {
        throw new Error('No tokens or auth code in return URL');
      }
    } catch (e) {
      Alert.alert(t('common.error'), (e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const disabled = loading || submitting;

  return (
    <Pressable
      style={[
        styles.oauthButton,
        { backgroundColor: colors.surface, borderColor: colors.border, opacity: disabled ? 0.6 : 1 },
      ]}
      onPress={handleGoogle}
      disabled={disabled}
    >
      <Text style={[typography.button, { color: colors.text }]}>
        {t('auth.continueWithGoogle')}
      </Text>
    </Pressable>
  );
}

function UnconfiguredGoogleButton({ loading }: { loading: boolean }) {
  const { t } = useTranslation();
  const colors = useThemeColors();

  const handleGoogle = () => {
    Alert.alert(
      t('common.error'),
      'Google Sign-In ist noch nicht konfiguriert. Setze EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID, EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID und EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID in mobile/.env.',
    );
  };

  return (
    <Pressable
      style={[
        styles.oauthButton,
        { backgroundColor: colors.surface, borderColor: colors.border, opacity: loading ? 0.6 : 1 },
      ]}
      onPress={handleGoogle}
      disabled={loading}
    >
      <Text style={[typography.button, { color: colors.text }]}>
        {t('auth.continueWithGoogle')}
      </Text>
    </Pressable>
  );
}

export function LoginScreen() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const navigation = useNavigation<Nav>();
  const route = useRoute<Route>();
  const { signInWithApple, signInWithEmail } = useAuth();
  const [showEmailForm, setShowEmailForm] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    const params = route.params;
    if (params?.email) {
      setEmail(params.email);
      setShowEmailForm(true);
    }
    if (params?.flashMessage) {
      setInfo(params.flashMessage);
    }
  }, [route.params]);

  const onEmailChange = (value: string) => {
    setEmail(value);
    if (error) setError(null);
    if (info) setInfo(null);
  };
  const onPasswordChange = (value: string) => {
    setPassword(value);
    if (error) setError(null);
  };
  const goToForgotPassword = () => {
    navigation.navigate('ForgotPassword', { email: email.trim() || undefined });
  };

  const handleEmailAuth = async () => {
    if (!email.trim() || !password.trim()) return;
    setError(null);
    setLoading(true);
    try {
      await signInWithEmail(email.trim(), password);
    } catch (e) {
      setError(translateAuthError(e, t));
    } finally {
      setLoading(false);
    }
  };

  const handleApple = async () => {
    setError(null);
    setLoading(true);
    try {
      await signInWithApple();
    } catch (e) {
      const message = (e as Error).message ?? '';
      if (!/cancel/i.test(message) && !/ERR_REQUEST_CANCELED/.test(message)) {
        setError(translateAuthError(e, t));
      }
    } finally {
      setLoading(false);
    }
  };

  const goToRegister = () => {
    navigation.navigate('Register');
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.content}>
        <Image
          source={require('../../../assets/icon.png')}
          style={styles.logo}
          resizeMode="contain"
        />

        <Text style={[typography.h1, { color: colors.text, textAlign: 'center' }]}>
          Cheffity
        </Text>
        <Text
          style={[
            typography.body,
            { color: colors.textSecondary, textAlign: 'center', marginTop: spacing.sm },
          ]}
        >
          {t('auth.tagline')}
        </Text>

        <View style={styles.buttons}>
          {!showEmailForm ? (
            <>
              {GOOGLE_AVAILABLE ? (
                Platform.OS === 'web' ? (
                  <GoogleSignInButton loading={loading} />
                ) : (
                  <NativeGoogleSignInButton loading={loading} />
                )
              ) : (
                <UnconfiguredGoogleButton loading={loading} />
              )}

              {Platform.OS === 'ios' && (
                <Pressable
                  style={[
                    styles.oauthButton,
                    { backgroundColor: colors.text, opacity: loading ? 0.6 : 1 },
                  ]}
                  onPress={handleApple}
                  disabled={loading}
                >
                  <Text style={[typography.button, { color: colors.background }]}>
                    {t('auth.continueWithApple')}
                  </Text>
                </Pressable>
              )}

              <Pressable
                style={[styles.oauthButton, { backgroundColor: colors.primary }]}
                onPress={() => setShowEmailForm(true)}
              >
                <Text style={[typography.button, { color: '#FFFFFF' }]}>
                  {t('auth.continueWithEmail')}
                </Text>
              </Pressable>

              <Pressable onPress={goToRegister} style={styles.registerLink}>
                <Text style={[typography.bodySmall, { color: colors.primary, textAlign: 'center' }]}>
                  {t('auth.noAccount')}
                </Text>
              </Pressable>
            </>
          ) : (
            <>
              <TextInput
                style={[
                  styles.input,
                  { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text },
                ]}
                placeholder={t('auth.email')}
                placeholderTextColor={colors.textTertiary}
                value={email}
                onChangeText={onEmailChange}
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
              />
              <TextInput
                style={[
                  styles.input,
                  { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text },
                ]}
                placeholder={t('auth.password')}
                placeholderTextColor={colors.textTertiary}
                value={password}
                onChangeText={onPasswordChange}
                secureTextEntry
                autoComplete="password"
              />

              {info && (
                <View
                  style={[
                    styles.infoBox,
                    { backgroundColor: colors.accentLight, borderColor: colors.accent },
                  ]}
                >
                  <Text style={[typography.bodySmall, { color: colors.accent }]}>
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
                  <Text style={[typography.bodySmall, { color: colors.error }]}>
                    {error}
                  </Text>
                </View>
              )}

              <Pressable
                style={[
                  styles.oauthButton,
                  { backgroundColor: colors.primary, opacity: loading ? 0.6 : 1 },
                ]}
                onPress={handleEmailAuth}
                disabled={loading}
              >
                <Text style={[typography.button, { color: '#FFFFFF' }]}>
                  {t('auth.login')}
                </Text>
              </Pressable>

              <Pressable onPress={goToForgotPassword}>
                <Text
                  style={[
                    typography.bodySmall,
                    { color: colors.primary, textAlign: 'center' },
                  ]}
                >
                  {t('auth.forgotPasswordLink')}
                </Text>
              </Pressable>

              <Pressable onPress={goToRegister}>
                <Text style={[typography.bodySmall, { color: colors.primary, textAlign: 'center' }]}>
                  {t('auth.noAccount')}
                </Text>
              </Pressable>

              <Pressable onPress={() => { setShowEmailForm(false); setError(null); }}>
                <Text
                  style={[
                    typography.bodySmall,
                    { color: colors.textSecondary, textAlign: 'center', marginTop: spacing.sm },
                  ]}
                >
                  {t('common.back')}
                </Text>
              </Pressable>
            </>
          )}
        </View>

        <View style={styles.legalRow}>
          <Pressable onPress={() => Linking.openURL(PRIVACY_URL)} hitSlop={8}>
            <Text style={[typography.caption, { color: colors.textSecondary, textDecorationLine: 'underline' }]}>
              {t('auth.privacyPolicy')}
            </Text>
          </Pressable>
          <Text style={[typography.caption, { color: colors.textTertiary }]}> · </Text>
          <Pressable onPress={() => Linking.openURL(TERMS_URL)} hitSlop={8}>
            <Text style={[typography.caption, { color: colors.textSecondary, textDecorationLine: 'underline' }]}>
              {t('auth.termsOfService')}
            </Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  logo: {
    width: 96,
    height: 96,
    alignSelf: 'center',
    marginBottom: spacing.lg,
  },
  buttons: {
    marginTop: spacing.xxl,
    gap: spacing.md,
  },
  oauthButton: {
    paddingVertical: 16,
    borderRadius: radius.md,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
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
  },
  infoBox: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  legalRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: spacing.xl,
  },
  registerLink: {
    paddingVertical: spacing.sm,
    marginTop: spacing.xs,
  },
});
