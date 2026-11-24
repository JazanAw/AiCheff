-- Cheffity: Offer-History weekly aggregation + snapshot-correct counts.
--
-- Background:
--   `offer_history_recent` (from 20260527000002) defines `observation_count`
--   as `count(*)` grouped by (canonical_product_key, store_name). After the
--   first production sync that produced inflated counts: any two offers
--   in the SAME snapshot that normalize to the same `canonical_product_key`
--   (different package sizes, slightly different brand spellings, same
--   item from two connectors) end up as two rows for the same group, so
--   the "wiederholt beobachtet"-stat already shows 2× before there's been
--   a second sync. That defeats the entire purpose of the field.
--
--   Fix:
--     - `observation_count` becomes `count(distinct snapshot_id)` — i.e.
--       "in how many sync runs did we see this product at this store".
--     - Add a `row_count` column so callers that genuinely want the raw
--       row count (debug / data-quality) still have it.
--     - New view `offer_history_weekly` for the per-ISO-week aggregate.
--
-- Calendar week:
--   `observed_at` is `timestamptz` (always stored UTC). ISO week / year
--   come from Postgres' `extract(isoyear ...)` / `extract(week ...)`,
--   which match ISO-8601 (Mon=1, week containing first Thursday of the
--   year is week 1) — exactly what DE/EU expect. `week_start_date` is
--   the Monday of that week.
--
-- View security:
--   Both views are owner-rights views (owned by `postgres`) and granted
--   only to `service_role`. Authenticated cannot read them directly,
--   same posture as the 2026-05-28 push of the base view.
--
-- Compatibility:
--   `create or replace view` only allows adding columns at the end.
--   The existing column order in `offer_history_recent`
--     canonical_product_key, store_name, sample_name, sample_brand,
--     observation_count, min_price, max_price, first_observed,
--     last_observed, has_active
--   stays untouched; `row_count` is appended.

-- ─── offer_history_recent — corrected observation_count ───────────────────

create or replace view public.offer_history_recent as
  select
    canonical_product_key,
    store_name,
    max(product_name)             as sample_name,
    max(brand)                    as sample_brand,
    count(distinct snapshot_id)::int as observation_count,
    min(price)                    as min_price,
    max(price)                    as max_price,
    min(observed_at)              as first_observed,
    max(observed_at)              as last_observed,
    bool_or(expired_at is null)   as has_active,
    -- Raw row count kept for debug / data-quality views ("how many
    -- duplicate rows does the same snapshot produce for this product").
    count(*)::int                 as row_count
  from public.offer_history
  group by canonical_product_key, store_name;

-- The base view was already service_role-only after the 2026-05-28 fix;
-- `create or replace view` preserves existing grants. Repeating it makes
-- the intent explicit and is safe (it is idempotent).
grant select on public.offer_history_recent to service_role;

-- ─── offer_history_weekly — per-ISO-week aggregate ────────────────────────
-- One row per (canonical_product_key, store_name, ISO-year, ISO-week).
-- Snapshot count semantics are the same as the corrected recent view.

create view public.offer_history_weekly as
  select
    canonical_product_key,
    store_name,
    extract(isoyear from observed_at)::int as iso_year,
    extract(week    from observed_at)::int as iso_week,
    -- Monday 00:00 UTC of that ISO week. `date_trunc('week', ...)` is
    -- ISO-aligned in Postgres (Monday-based), so this matches iso_year/
    -- iso_week even at year boundaries.
    (date_trunc('week', observed_at) at time zone 'UTC')::date as week_start_date,
    max(product_name)                  as sample_name,
    max(brand)                         as sample_brand,
    count(distinct snapshot_id)::int   as snapshot_count,
    count(*)::int                      as row_count,
    min(price)                         as min_price,
    max(price)                         as max_price,
    avg(price)::numeric(10,2)          as avg_price,
    min(observed_at)                   as first_observed,
    max(observed_at)                   as last_observed
  from public.offer_history
  group by
    canonical_product_key,
    store_name,
    extract(isoyear from observed_at),
    extract(week    from observed_at),
    date_trunc('week', observed_at);

grant select on public.offer_history_weekly to service_role;

-- ─── Retention helper — SQL function, not invoked yet ─────────────────────
-- Suggestion only: a deterministic, RLS-bypassing function the future
-- daily cron (Edge Function / pg_cron) can call. NOT scheduled here.
-- Kept as `security definer` so the eventual cron entry can be on a
-- non-admin role.

create or replace function public.cleanup_offer_history(retention_months int default 12)
returns table(deleted_rows bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cutoff timestamptz := now() - make_interval(months => retention_months);
  v_count  bigint;
begin
  delete from public.offer_history
   where observed_at < v_cutoff;
  get diagnostics v_count = row_count;
  deleted_rows := v_count;
  return next;
end;
$$;

revoke all on function public.cleanup_offer_history(int) from public;
grant execute on function public.cleanup_offer_history(int) to service_role;
