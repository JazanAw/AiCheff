import { supabase } from '../config/supabase';

/**
 * External (web) Stripe checkout. This is intentionally OFF by default.
 *
 * Store builds for iOS/Android ship with
 * EXPO_PUBLIC_ENABLE_EXTERNAL_STRIPE_CHECKOUT unset / "false" so we never
 * trigger an external-payment flow during App Store / Play review. Only dev
 * or web-oriented builds set it to "true". See docs/stripe-integration.md.
 *
 * EXPO_PUBLIC_* vars are inlined by Expo at build time, so this constant is
 * fixed per build.
 */
export const EXTERNAL_STRIPE_CHECKOUT_ENABLED =
  process.env.EXPO_PUBLIC_ENABLE_EXTERNAL_STRIPE_CHECKOUT === 'true';

export type PaidTier = 'plus' | 'premium';

/** Thrown when checkout/portal is called while the env flag is disabled. */
export class StripeCheckoutDisabledError extends Error {
  constructor() {
    super('external_stripe_checkout_disabled');
    this.name = 'StripeCheckoutDisabledError';
  }
}

type StripeFunction = 'stripe-checkout' | 'stripe-portal';

/**
 * Invokes a Stripe Edge Function and returns the hosted URL it produced.
 * The user JWT is attached automatically by supabase-js. No secrets live in
 * the mobile app — the Edge Function holds the Stripe keys.
 */
async function invokeForUrl(
  fn: StripeFunction,
  body?: Record<string, unknown>,
): Promise<string> {
  if (!EXTERNAL_STRIPE_CHECKOUT_ENABLED) {
    // Backstop — UI already gates on the flag, but never call out if disabled.
    throw new StripeCheckoutDisabledError();
  }
  const { data, error } = await supabase.functions.invoke(fn, body ? { body } : {});
  if (error) {
    throw error;
  }
  const url = (data as { url?: unknown } | null)?.url;
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('stripe_no_url');
  }
  return url;
}

/** Creates a Stripe Checkout session for the given tier, returns its URL. */
export function startStripeCheckout(tier: PaidTier): Promise<string> {
  return invokeForUrl('stripe-checkout', { tier });
}

/** Creates a Stripe Billing Portal session, returns its URL. */
export function openStripePortal(): Promise<string> {
  return invokeForUrl('stripe-portal');
}
