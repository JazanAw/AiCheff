// Shared Stripe helpers for the Edge Functions.
//
// Stripe SDK is server-side only — it never ships to the mobile client.
// `?target=deno` gives an esm.sh build that works in the Supabase edge runtime.

import Stripe from 'https://esm.sh/stripe@17?target=deno';
import { getEnv } from './supabase.ts';

export type PaidTier = 'plus' | 'premium';

/** Type guard for the request body `{ tier }` value. */
export function isPaidTier(value: unknown): value is PaidTier {
  return value === 'plus' || value === 'premium';
}

/**
 * Stripe client configured for the Deno edge runtime: the fetch-based HTTP
 * client is required (Deno has no Node http). apiVersion is intentionally
 * omitted so the account default is used.
 */
export function getStripeClient(): Stripe {
  return new Stripe(getEnv('STRIPE_SECRET_KEY'), {
    httpClient: Stripe.createFetchHttpClient(),
  });
}

/** Stripe price id for a paid tier — env-driven, so no DB table is needed. */
export function priceIdForTier(tier: PaidTier): string {
  return tier === 'plus'
    ? getEnv('STRIPE_PRICE_PLUS')
    : getEnv('STRIPE_PRICE_PREMIUM');
}

/**
 * Reverse mapping: Stripe price id -> tier. Used by the webhook to derive the
 * tier from a subscription's line item (e.g. after a plan change via the
 * Customer Portal). Returns null for unknown price ids.
 */
export function tierForPriceId(priceId: string | null | undefined): PaidTier | null {
  if (!priceId) {
    return null;
  }
  if (priceId === getEnv('STRIPE_PRICE_PLUS')) {
    return 'plus';
  }
  if (priceId === getEnv('STRIPE_PRICE_PREMIUM')) {
    return 'premium';
  }
  return null;
}

export { Stripe };
