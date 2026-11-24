// Receives Stripe webhook events and keeps public.subscriptions in sync.
//
// Auth: NO user JWT — Stripe calls this endpoint directly. `verify_jwt = false`
// is set for this function in supabase/config.toml. Instead we verify the
// `Stripe-Signature` header against STRIPE_WEBHOOK_SECRET.
//
// Writes run with the service_role client (bypasses RLS — subscriptions is
// otherwise read-only for users).
//
// Idempotency: every successfully handled event id is recorded in
// public.stripe_events. A re-delivered event is detected and skipped.
//
// Status codes:
//   200 — handled, or duplicate (skip). Stripe stops retrying.
//   400 — bad/missing signature or config. Retrying would not help.
//   500 — handler threw (e.g. transient DB error). Stripe retries with
//         backoff; the event is NOT recorded so the retry re-processes it.
//   (This is a deliberate refinement of docs/stripe-integration.md §6.4, which said
//    "always 200" — silently swallowing failures would lose subscription
//    updates. See docs/stripe-integration.md changelog.)

import { getAdminClient, type SupabaseClient } from '../_shared/supabase.ts';
import { getStripeClient, Stripe, tierForPriceId } from '../_shared/stripe.ts';

// Stripe subscription statuses — identical to the public.subscription_status
// enum (see migration 20260507000001_init.sql), so we can pass them through.
const SUBSCRIPTION_STATUSES = new Set<string>([
  'active', 'trialing', 'past_due', 'canceled',
  'incomplete', 'incomplete_expired', 'unpaid', 'paused',
]);

function mapStatus(stripeStatus: string): string {
  return SUBSCRIPTION_STATUSES.has(stripeStatus) ? stripeStatus : 'active';
}

function toIso(unixSeconds: number | null | undefined): string | null {
  return typeof unixSeconds === 'number'
    ? new Date(unixSeconds * 1000).toISOString()
    : null;
}

function readPeriod(sub: Stripe.Subscription): { start: string | null; end: string | null } {
  // Stripe moved current_period_* from the subscription onto its items in
  // newer API versions. Read whichever the account/SDK exposes.
  const subLevel = sub as unknown as {
    current_period_start?: number;
    current_period_end?: number;
  };
  const firstItem = sub.items?.data?.[0] as unknown as {
    current_period_start?: number;
    current_period_end?: number;
  } | undefined;
  const start = subLevel.current_period_start ?? firstItem?.current_period_start ?? null;
  const end = subLevel.current_period_end ?? firstItem?.current_period_end ?? null;
  return { start: toIso(start), end: toIso(end) };
}

async function resolveUserIdByCustomer(
  admin: SupabaseClient,
  customerId: string | null,
): Promise<string | null> {
  if (!customerId) {
    return null;
  }
  const { data } = await admin
    .from('subscriptions')
    .select('user_id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();
  return data?.user_id ?? null;
}

async function resolveUserIdFromSubscription(
  admin: SupabaseClient,
  sub: Stripe.Subscription,
): Promise<string | null> {
  // Prefer the metadata we attached in stripe-checkout (subscription_data).
  const metaUserId = sub.metadata?.user_id;
  if (metaUserId) {
    return metaUserId;
  }
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? null;
  return resolveUserIdByCustomer(admin, customerId);
}

async function resolveUserIdFromInvoice(
  admin: SupabaseClient,
  invoice: Stripe.Invoice,
): Promise<string | null> {
  const customerId = typeof invoice.customer === 'string'
    ? invoice.customer
    : invoice.customer?.id ?? null;
  return resolveUserIdByCustomer(admin, customerId);
}

/** Writes the current Stripe subscription state onto public.subscriptions. */
async function applySubscription(
  admin: SupabaseClient,
  sub: Stripe.Subscription,
): Promise<void> {
  const userId = await resolveUserIdFromSubscription(admin, sub);
  if (!userId) {
    console.warn('[stripe-webhook] could not resolve user for subscription', sub.id);
    return;
  }
  const status = mapStatus(sub.status);
  const { start, end } = readPeriod(sub);
  const update: Record<string, unknown> = {
    status,
    stripe_subscription_id: sub.id,
    current_period_start: start,
    current_period_end: end,
    cancel_at_period_end: sub.cancel_at_period_end ?? false,
  };
  if (status === 'canceled') {
    update.tier = 'free';
  } else {
    const tier = tierForPriceId(sub.items?.data?.[0]?.price?.id);
    if (tier) {
      update.tier = tier;
    } else {
      // Unknown price id — keep the existing tier, only sync status/period.
      console.warn('[stripe-webhook] unknown price id on subscription', sub.id);
    }
  }
  await admin.from('subscriptions').update(update).eq('user_id', userId);
}

async function handleEvent(
  stripe: Stripe,
  admin: SupabaseClient,
  event: Stripe.Event,
): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const subscriptionId = typeof session.subscription === 'string'
        ? session.subscription
        : session.subscription?.id ?? null;
      if (subscriptionId) {
        // Retrieve the full subscription for tier/period/status, then sync.
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        await applySubscription(admin, sub);
      } else {
        console.warn('[stripe-webhook] checkout.session.completed without subscription', session.id);
      }
      break;
    }
    case 'customer.subscription.updated': {
      await applySubscription(admin, event.data.object as Stripe.Subscription);
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const userId = await resolveUserIdFromSubscription(admin, sub);
      if (!userId) {
        console.warn('[stripe-webhook] could not resolve user for deleted subscription', sub.id);
        break;
      }
      await admin
        .from('subscriptions')
        .update({ tier: 'free', status: 'canceled', cancel_at_period_end: false })
        .eq('user_id', userId);
      break;
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const userId = await resolveUserIdFromInvoice(admin, invoice);
      if (userId) {
        await admin.from('subscriptions').update({ status: 'past_due' }).eq('user_id', userId);
      }
      break;
    }
    case 'invoice.paid': {
      const invoice = event.data.object as Stripe.Invoice;
      const userId = await resolveUserIdFromInvoice(admin, invoice);
      if (userId) {
        // Re-affirm active; period info also arrives via customer.subscription.updated.
        await admin.from('subscriptions').update({ status: 'active' }).eq('user_id', userId);
      }
      break;
    }
    default:
      // Unhandled event type — still recorded for idempotency, no action taken.
      break;
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('method_not_allowed', { status: 405 });
  }

  const signature = req.headers.get('Stripe-Signature');
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  if (!signature || !webhookSecret) {
    console.error('[stripe-webhook] missing signature or STRIPE_WEBHOOK_SECRET');
    return new Response('misconfigured', { status: 400 });
  }

  const rawBody = await req.text();
  const stripe = getStripeClient();
  // SubtleCrypto provider — Deno has no Node crypto, this uses Web Crypto.
  const cryptoProvider = Stripe.createSubtleCryptoProvider();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      webhookSecret,
      undefined,
      cryptoProvider,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[stripe-webhook] signature verification failed:', message);
    return new Response('invalid_signature', { status: 400 });
  }

  const admin = getAdminClient();

  // Idempotency: if this event id was already handled, skip.
  const { data: existing } = await admin
    .from('stripe_events')
    .select('id')
    .eq('id', event.id)
    .maybeSingle();
  if (existing) {
    return new Response(JSON.stringify({ received: true, duplicate: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    await handleEvent(stripe, admin, event);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[stripe-webhook] handler error for', event.type, message);
    // Do NOT record the event — return 500 so Stripe retries it.
    return new Response('handler_error', { status: 500 });
  }

  // Record only after successful handling. A concurrent duplicate delivery may
  // race here; the primary-key conflict is expected and harmless.
  const { error: insertError } = await admin
    .from('stripe_events')
    .insert({ id: event.id, event_type: event.type });
  if (insertError) {
    console.log('[stripe-webhook] event id insert skipped (likely duplicate):', event.id);
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
