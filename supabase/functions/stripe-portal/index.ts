// Creates a Stripe Billing Portal session so a paying user can manage or
// cancel their subscription.
//
// Auth: requires a valid user JWT. The user id comes from the verified token.
// The user must already have a stripe_customer_id (i.e. they went through
// checkout at least once) — otherwise there is nothing to manage.

import { jsonResponse } from '../_shared/http.ts';
import { getAdminClient, getEnv, getUserFromRequest } from '../_shared/supabase.ts';
import { getStripeClient } from '../_shared/stripe.ts';

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

    const admin = getAdminClient();
    const { data: subRow } = await admin
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .maybeSingle();

    const customerId: string | null = subRow?.stripe_customer_id ?? null;
    if (!customerId) {
      return jsonResponse({ error: 'no_stripe_customer' }, { status: 404 });
    }

    const stripe = getStripeClient();
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      // Stripe requires an http(s) return_url; the app's deep link works once
      // the scheme is registered. Reuses the checkout success deep link.
      return_url: getEnv('APP_DEEP_LINK_SUCCESS'),
    });

    if (!session.url) {
      return jsonResponse({ error: 'portal_session_no_url' }, { status: 502 });
    }
    return jsonResponse({ url: session.url });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[stripe-portal]', message);
    return jsonResponse({ error: 'portal_failed', detail: message }, { status: 500 });
  }
});
