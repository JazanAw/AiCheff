// Creates a Stripe Checkout session (mode=subscription) for the calling user.
//
// Auth: requires a valid user JWT (Supabase auto-attaches it when called via
// supabase.functions.invoke from a logged-in client). The user id comes from
// the verified token, never from the request body.
//
// Flow: reuse the user's stripe_customer_id if we already created one,
// otherwise create a Stripe customer and persist the id. Then create a
// Checkout session and return its hosted URL — the mobile app opens it in the
// browser. The subscription state is written later by the stripe-webhook
// function; this function never writes `tier`/`status`.

import { jsonResponse } from '../_shared/http.ts';
import { getAdminClient, getEnv, getUserFromRequest } from '../_shared/supabase.ts';
import { getStripeClient, isPaidTier, priceIdForTier } from '../_shared/stripe.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return jsonResponse({ ok: true });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, { status: 405 });
  }

  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return jsonResponse({ error: 'unauthorized' }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: 'invalid_body' }, { status: 400 });
    }
    const tier = (body as { tier?: unknown }).tier;
    if (!isPaidTier(tier)) {
      return jsonResponse({ error: 'invalid_tier' }, { status: 400 });
    }

    const stripe = getStripeClient();
    const admin = getAdminClient();

    // Reuse the Stripe customer if one was already created for this user.
    const { data: subRow } = await admin
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .maybeSingle();

    let customerId: string | null = subRow?.stripe_customer_id ?? null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        metadata: { user_id: user.id },
      });
      customerId = customer.id;
      await admin
        .from('subscriptions')
        .update({ stripe_customer_id: customerId })
        .eq('user_id', user.id);
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceIdForTier(tier), quantity: 1 }],
      success_url: getEnv('APP_DEEP_LINK_SUCCESS'),
      cancel_url: getEnv('APP_DEEP_LINK_CANCEL'),
      // Carried on both the session and the subscription so the webhook can
      // resolve the user from any later subscription.* event.
      metadata: { user_id: user.id, tier },
      subscription_data: { metadata: { user_id: user.id, tier } },
    });

    if (!session.url) {
      return jsonResponse({ error: 'checkout_session_no_url' }, { status: 502 });
    }
    return jsonResponse({ url: session.url });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[stripe-checkout]', message);
    return jsonResponse({ error: 'checkout_failed', detail: message }, { status: 500 });
  }
});
