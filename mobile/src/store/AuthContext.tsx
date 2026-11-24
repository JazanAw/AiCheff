import React, { createContext, useContext, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '../config/supabase';

type IdTokenProvider = 'google' | 'apple';

interface SignUpParams {
  email: string;
  password: string;
  phone?: string;
}

interface SignUpResult {
  needsEmailVerification: boolean;
  alreadyRegistered: boolean;
}

interface AuthState {
  session: Session | null;
  user: User | null;
  isLoading: boolean;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signUpWithEmail: (params: SignUpParams) => Promise<SignUpResult>;
  verifyEmailOtp: (email: string, token: string) => Promise<void>;
  resendEmailOtp: (email: string) => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  verifyResetOtp: (email: string, token: string) => Promise<void>;
  updatePassword: (newPassword: string) => Promise<void>;
  signInWithApple: () => Promise<void>;
  signInWithIdToken: (provider: IdTokenProvider, token: string, nonce?: string) => Promise<void>;
  signOut: () => Promise<void>;
  deleteAccount: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

function generateRawNonce(byteCount = 16): string {
  const bytes = Crypto.getRandomBytes(byteCount);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      setIsLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, s) => {
        setSession(s);
      },
    );

    return () => subscription.unsubscribe();
  }, []);

  const signInWithEmail = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  };

  const signUpWithEmail = async ({ email, password, phone }: SignUpParams): Promise<SignUpResult> => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: phone ? { phone } : undefined,
      },
    });
    if (error) throw error;

    // Supabase signal for "email already registered" with email confirmation
    // enabled: a user is returned but identities array is empty.
    const alreadyRegistered =
      data.user != null &&
      Array.isArray(data.user.identities) &&
      data.user.identities.length === 0;

    return {
      needsEmailVerification: !data.session && !alreadyRegistered,
      alreadyRegistered,
    };
  };

  const verifyEmailOtp = async (email: string, token: string) => {
    const { error } = await supabase.auth.verifyOtp({
      email,
      token,
      type: 'signup',
    });
    if (error) throw error;
  };

  const resendEmailOtp = async (email: string) => {
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email,
    });
    if (error) throw error;
  };

  const requestPasswordReset = async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email);
    if (error) throw error;
  };

  const verifyResetOtp = async (email: string, token: string) => {
    const { error } = await supabase.auth.verifyOtp({
      email,
      token,
      type: 'recovery',
    });
    if (error) throw error;
  };

  const updatePassword = async (newPassword: string) => {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw error;
  };

  const signInWithIdToken: AuthState['signInWithIdToken'] = async (provider, token, nonce) => {
    const { error } = await supabase.auth.signInWithIdToken({ provider, token, nonce });
    if (error) throw error;
  };

  const signInWithApple = async () => {
    if (Platform.OS !== 'ios') {
      throw new Error('Apple Sign-In is only available on iOS');
    }
    const available = await AppleAuthentication.isAvailableAsync();
    if (!available) {
      throw new Error('Apple Sign-In is not available on this device');
    }

    const rawNonce = generateRawNonce();
    const hashedNonce = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      rawNonce,
    );

    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: hashedNonce,
    });

    if (!credential.identityToken) {
      throw new Error('Apple did not return an identity token');
    }

    await signInWithIdToken('apple', credential.identityToken, rawNonce);
  };

  const signOut = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  };

  const deleteAccount = async () => {
    const { error } = await supabase.functions.invoke('delete-account');
    if (error) throw error;
    await signOut();
  };

  return (
    <AuthContext.Provider
      value={{
        session,
        user: session?.user ?? null,
        isLoading,
        signInWithEmail,
        signUpWithEmail,
        verifyEmailOtp,
        resendEmailOtp,
        requestPasswordReset,
        verifyResetOtp,
        updatePassword,
        signInWithApple,
        signInWithIdToken,
        signOut,
        deleteAccount,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
