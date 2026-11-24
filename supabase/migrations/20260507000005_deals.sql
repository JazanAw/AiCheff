-- Cheffity schema: deals, deal-recipe matches, deal scan log.

-- deals --------------------------------------------------------------------

create table public.deals (
  id                  uuid primary key default gen_random_uuid(),
  source              text not null check (source in ('marktguru', 'kaufda', 'manual')),
  source_external_id  text,
  name                text not null,
  store_name          text not null,
  store_logo_url      text,
  category            public.deal_category not null default 'other',
  current_price       numeric(10,2) not null check (current_price >= 0),
  original_price      numeric(10,2) check (original_price is null or original_price >= current_price),
  savings_percent     numeric(5,2)  check (savings_percent is null or savings_percent between 0 and 100),
  image_url           text,
  valid_from          date not null,
  valid_to            date not null check (valid_to >= valid_from),
  is_national         boolean not null default false,
  region_postal_code  text,
  region_country      char(2) not null default 'DE',
  ingredients         text[] not null default '{}',
  is_food             boolean,
  is_halal            boolean,
  contains_alcohol    boolean,
  allergens           public.allergen[] not null default '{}',
  nutrition           jsonb,
  raw_payload         jsonb,
  is_verified         boolean not null default false,
  is_flagged          boolean not null default false,
  flagged_reason      text,
  scanned_at          timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint deals_source_external_unique unique (source, source_external_id)
);

create index deals_category_idx     on public.deals (category);
create index deals_valid_idx        on public.deals (valid_from, valid_to);
create index deals_store_idx        on public.deals (store_name);
create index deals_scanned_at_idx   on public.deals (scanned_at desc);
create index deals_postal_idx       on public.deals (region_postal_code) where region_postal_code is not null;
create index deals_valid_to_idx     on public.deals (valid_to);

create trigger deals_set_updated_at
  before update on public.deals
  for each row execute function public.set_updated_at();

-- deal_recipe_matches ------------------------------------------------------
-- Links a deal to a recipe ingredient. Many-to-many.

create table public.deal_recipe_matches (
  id                    uuid primary key default gen_random_uuid(),
  deal_id               uuid not null references public.deals(id) on delete cascade,
  recipe_ingredient_id  uuid not null references public.recipe_ingredients(id) on delete cascade,
  match_score           numeric(4,3) not null default 1.0 check (match_score between 0 and 1),
  is_verified           boolean not null default false,
  matched_by_admin      uuid references auth.users(id),
  created_at            timestamptz not null default now(),

  constraint deal_recipe_matches_unique unique (deal_id, recipe_ingredient_id)
);

create index deal_recipe_matches_deal_idx
  on public.deal_recipe_matches (deal_id);
create index deal_recipe_matches_ingredient_idx
  on public.deal_recipe_matches (recipe_ingredient_id);

-- deal_scans ---------------------------------------------------------------
-- Log of scan runs (manual or scheduled weekly Monday job).

create table public.deal_scans (
  id              uuid primary key default gen_random_uuid(),
  triggered_by    uuid references auth.users(id),
  trigger         text not null check (trigger in ('manual', 'cron', 'webhook')),
  region          text,
  status          public.deal_scan_status not null default 'running',
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  count_added     int,
  count_updated   int,
  count_failed    int,
  error_message   text,
  log             jsonb
);

create index deal_scans_started_idx on public.deal_scans (started_at desc);

-- RLS ----------------------------------------------------------------------

alter table public.deals                 enable row level security;
alter table public.deal_recipe_matches   enable row level security;
alter table public.deal_scans            enable row level security;

-- Deals readable by all authenticated users; writes admin-only (service_role bypasses RLS for ingestion).
create policy deals_read on public.deals
  for select to authenticated
  using (true);

create policy deals_admin_write on public.deals
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy deal_recipe_matches_read on public.deal_recipe_matches
  for select to authenticated
  using (true);

create policy deal_recipe_matches_admin_write on public.deal_recipe_matches
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy deal_scans_admin_only on public.deal_scans
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());
