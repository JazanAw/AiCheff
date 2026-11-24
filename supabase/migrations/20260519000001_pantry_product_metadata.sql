-- Pantry product metadata — Phase 1 of the pantry-scanner feature.
--
-- Extends public.pantry_items with the fields needed to store a scanned
-- product (Open Food Facts payload + barcode + branding). RLS is unchanged —
-- the existing pantry_items_self_all policy covers all new columns.
--
-- Design notes:
--   - All new columns are nullable / have a default so existing rows are
--     untouched (no backfill needed).
--   - `barcode` is text (NOT a number) — EAN-13 may have a leading zero that
--     a numeric type would silently drop.
--   - `ingredients_text` is text[] with default '{}' so app code can treat
--     it as a list without null-checks.
--   - `lookup_source` defaults to 'manual' so legacy manual rows match
--     reality, and the new CHECK guards the enum-like contract on the app
--     side (no Postgres enum because the value set may grow).
--   - The new partial index is tuned for the dedupe lookup "do I already
--     have this product still in the pantry?" — only active rows with a
--     known barcode qualify.

alter table public.pantry_items
  add column if not exists barcode             text,
  add column if not exists brand               text,
  add column if not exists product_name        text,
  add column if not exists category            text,
  add column if not exists image_url           text,
  add column if not exists nutrition           jsonb,
  add column if not exists ingredients_text    text[] not null default '{}',
  add column if not exists raw_product_payload jsonb,
  add column if not exists lookup_source       text not null default 'manual';

-- Constrain lookup_source to the known sources. Drop+add so the migration
-- is rerunnable against a partially-applied state.
alter table public.pantry_items
  drop constraint if exists pantry_items_lookup_source_check;
alter table public.pantry_items
  add  constraint pantry_items_lookup_source_check
    check (lookup_source in ('manual', 'openfoodfacts', 'shopping_list', 'recipe_residual'));

create index if not exists pantry_items_user_barcode_active_idx
  on public.pantry_items (user_id, barcode)
  where barcode is not null and consumed_at is null;
