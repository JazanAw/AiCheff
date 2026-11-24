-- Cheffity schema: profiles, user_preferences, subscriptions, push tokens.
-- One profile/preferences row per auth.users via handle_new_user trigger.

-- profiles -----------------------------------------------------------------

create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         citext not null unique,
  display_name  text,
  avatar_url    text,
  language      public.language_code not null default 'de',
  country_code  char(2),
  onboarding_completed boolean not null default false,
  banned        boolean not null default false,
  banned_reason text,
  banned_at     timestamptz,
  last_active_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- user_preferences ---------------------------------------------------------

create table public.user_preferences (
  user_id              uuid primary key references auth.users(id) on delete cascade,
  search_radius_km     int  not null default 15 check (search_radius_km between 1 and 100),
  allergies            public.allergen[] not null default '{}',
  halal_filter         boolean not null default false,
  hide_alcohol         boolean not null default false,
  excluded_foods       text[] not null default '{}',
  default_portion_size int not null default 2 check (default_portion_size between 1 and 12),
  latitude             double precision,
  longitude            double precision,
  postal_code          text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create trigger user_preferences_set_updated_at
  before update on public.user_preferences
  for each row execute function public.set_updated_at();

-- subscriptions ------------------------------------------------------------

create table public.subscriptions (
  user_id                 uuid primary key references auth.users(id) on delete cascade,
  tier                    public.subscription_tier not null default 'free',
  status                  public.subscription_status not null default 'active',
  stripe_customer_id      text unique,
  stripe_subscription_id  text unique,
  current_period_start    timestamptz,
  current_period_end      timestamptz,
  cancel_at_period_end    boolean not null default false,
  set_by_admin            boolean not null default false,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index subscriptions_tier_status_idx on public.subscriptions (tier, status);

create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

-- Add to realtime publication so SubscriptionContext sees live updates.
alter publication supabase_realtime add table public.subscriptions;

-- user_push_tokens ---------------------------------------------------------

create table public.user_push_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  expo_token  text not null unique,
  platform    text not null check (platform in ('ios', 'android')),
  last_seen_at timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index user_push_tokens_user_idx on public.user_push_tokens (user_id);

-- Trigger: bootstrap a profile, free subscription, and default preferences
-- whenever a new auth.users row is created.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'name', new.raw_user_meta_data ->> 'full_name'),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;

  insert into public.user_preferences (user_id) values (new.id)
  on conflict (user_id) do nothing;

  insert into public.subscriptions (user_id, tier, status)
  values (new.id, 'free', 'active')
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- RLS ----------------------------------------------------------------------

alter table public.profiles          enable row level security;
alter table public.user_preferences  enable row level security;
alter table public.subscriptions     enable row level security;
alter table public.user_push_tokens  enable row level security;

-- profiles: user reads/edits their own row; admins see/edit all.
create policy profiles_self_select on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_admin());

create policy profiles_self_update on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy profiles_admin_update on public.profiles
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy profiles_admin_delete on public.profiles
  for delete to authenticated
  using (public.is_admin());

-- user_preferences: same pattern.
create policy user_preferences_self_select on public.user_preferences
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy user_preferences_self_upsert on public.user_preferences
  for insert to authenticated
  with check (user_id = auth.uid());

create policy user_preferences_self_update on public.user_preferences
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy user_preferences_admin_update on public.user_preferences
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- subscriptions: user reads own; only admins or service_role write directly.
-- Stripe webhook should run with service_role, bypassing RLS.
create policy subscriptions_self_select on public.subscriptions
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy subscriptions_admin_write on public.subscriptions
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- push tokens: user manages their own.
create policy user_push_tokens_self_select on public.user_push_tokens
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy user_push_tokens_self_insert on public.user_push_tokens
  for insert to authenticated
  with check (user_id = auth.uid());

create policy user_push_tokens_self_update on public.user_push_tokens
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy user_push_tokens_self_delete on public.user_push_tokens
  for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());
