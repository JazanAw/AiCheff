-- Cheffity schema: extensions, enums, shared helpers, admins table.
-- All multilingual text is stored as jsonb { de, en, tr, it, es, pl }.
-- de is the canonical fallback.

create extension if not exists "pgcrypto";
create extension if not exists "citext";

-- Enums --------------------------------------------------------------------

create type public.subscription_tier as enum ('free', 'plus', 'premium');
create type public.subscription_status as enum (
  'active', 'trialing', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'unpaid', 'paused'
);
create type public.meal_type as enum ('breakfast', 'lunch', 'dinner', 'sweet_baked', 'drinks');
create type public.recipe_difficulty as enum ('easy', 'medium', 'advanced');
create type public.recipe_status as enum ('active', 'hidden');
create type public.deal_category as enum (
  'fruits_vegetables', 'meat_fish', 'dairy', 'drinks', 'snacks_sweets', 'frozen', 'other'
);
create type public.allergen as enum ('gluten', 'lactose', 'nuts', 'eggs', 'soy', 'fish', 'seafood', 'sesame');
create type public.swipe_action as enum ('not_now', 'add_to_plan', 'never', 'favorite', 'unfavorite');
create type public.gender as enum ('male', 'female');
create type public.activity_level as enum (
  'barely_active', 'lightly_active', 'moderately_active', 'very_active'
);
create type public.language_code as enum ('de', 'en', 'tr', 'it', 'es', 'pl');
create type public.push_audience as enum ('all', 'free', 'plus', 'premium', 'region');
create type public.push_status as enum ('scheduled', 'sent', 'failed', 'canceled');
create type public.cookbook_status as enum ('pending', 'extracting', 'extracted', 'saved', 'discarded', 'failed');
create type public.deal_scan_status as enum ('running', 'success', 'failed');
create type public.admin_role as enum ('owner', 'admin', 'editor');

-- Helpers ------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Returns a localized string from a jsonb i18n payload, falling back to de then en.
create or replace function public.tx(payload jsonb, locale text default 'de')
returns text
language sql
immutable
as $$
  select coalesce(
    nullif(payload ->> locale, ''),
    nullif(payload ->> 'de',     ''),
    nullif(payload ->> 'en',     '')
  );
$$;

-- Admins table needs to exist before is_admin() can reference it.
create table public.admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      citext not null unique,
  role       public.admin_role not null default 'admin',
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
comment on table public.admins is
  'Whitelist of admin user IDs. Membership grants access to admin RLS policies.';

-- Stable, security-definer wrapper used in RLS policies on other tables.
create or replace function public.is_admin(uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(select 1 from public.admins where user_id = uid);
$$;

revoke all on function public.is_admin(uuid) from public;
grant execute on function public.is_admin(uuid) to authenticated, service_role;

-- RLS for admins table itself: only admins can read/write.
alter table public.admins enable row level security;

create policy admins_select on public.admins
  for select to authenticated
  using (public.is_admin());

create policy admins_insert on public.admins
  for insert to authenticated
  with check (public.is_admin());

create policy admins_update on public.admins
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy admins_delete on public.admins
  for delete to authenticated
  using (public.is_admin());
