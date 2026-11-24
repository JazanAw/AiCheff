-- Stripe webhook idempotency log.
--
-- Stripe delivers events at-least-once (retries on non-2xx, occasional
-- duplicates). The stripe-webhook Edge Function records each handled event id
-- here AFTER it processed it successfully; on the next delivery of the same id
-- it sees the row and skips. See docs/stripe-integration.md.

create table public.stripe_events (
  id           text primary key,          -- Stripe event id (evt_...)
  event_type   text not null,             -- e.g. checkout.session.completed
  processed_at timestamptz not null default now()
);

-- Only the stripe-webhook function touches this table, and it runs with the
-- service_role key (bypasses RLS). RLS enabled + zero policies = deny all for
-- anon/authenticated, which is exactly what we want.
alter table public.stripe_events enable row level security;
