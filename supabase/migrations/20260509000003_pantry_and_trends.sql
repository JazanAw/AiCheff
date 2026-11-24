-- Pantry / Vorratskammer + Cook-Log + Trend Views.
--
-- Workflow:
--   shopping_list_items (intent) -> check off (purchased) -> pantry_items
--   pantry_items -> consumed_at set when user used them up
--   weekly_plan_entries (planned) -> recipe_cooked_log (actually cooked)
--
-- Trend views aggregate across users to power Plus/Premium trend cards.

-- ─── pantry_items ──────────────────────────────────────────────────────────

create type public.pantry_source as enum (
  'shopping_list', 'manual', 'recipe_residual'
);

create table public.pantry_items (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  name              text not null check (length(trim(name)) > 0),
  quantity          numeric(10,3) not null default 1 check (quantity > 0),
  unit              text not null default '',
  source            public.pantry_source not null default 'manual',
  shopping_item_id  uuid,  -- back-ref, FK added below to avoid cycle
  deal_id           uuid references public.deals(id) on delete set null,
  added_at          timestamptz not null default now(),
  consumed_at       timestamptz,
  expires_at        date,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index pantry_items_user_idx
  on public.pantry_items (user_id, added_at desc);
create index pantry_items_user_active_idx
  on public.pantry_items (user_id)
  where consumed_at is null;

create trigger pantry_items_set_updated_at
  before update on public.pantry_items
  for each row execute function public.set_updated_at();

-- ─── shopping_list_items: track purchase + link to pantry ──────────────────

alter table public.shopping_list_items
  add column if not exists purchased_at  timestamptz,
  add column if not exists pantry_item_id uuid references public.pantry_items(id) on delete set null;

-- Close the back-ref now that both tables exist.
alter table public.pantry_items
  add constraint pantry_items_shopping_fk
    foreign key (shopping_item_id) references public.shopping_list_items(id) on delete set null;

create index shopping_list_purchased_idx
  on public.shopping_list_items (user_id, purchased_at desc)
  where purchased_at is not null;

-- ─── recipe_cooked_log ─────────────────────────────────────────────────────

create table public.recipe_cooked_log (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  recipe_id             uuid not null references public.recipes(id) on delete cascade,
  weekly_plan_entry_id  uuid references public.weekly_plan_entries(id) on delete set null,
  cooked_at             timestamptz not null default now(),
  rating                numeric(2,1) check (rating is null or (rating between 0.5 and 5 and (rating * 10)::int % 5 = 0)),
  notes                 text,
  created_at            timestamptz not null default now()
);

create index recipe_cooked_user_idx     on public.recipe_cooked_log (user_id, cooked_at desc);
create index recipe_cooked_recipe_idx   on public.recipe_cooked_log (recipe_id, cooked_at desc);

-- Bump cached recipes.cooked_count whenever a new cook is logged.
create or replace function public.bump_recipe_cooked_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update public.recipes set cooked_count = cooked_count + 1 where id = new.recipe_id;
  elsif tg_op = 'DELETE' then
    update public.recipes set cooked_count = greatest(0, cooked_count - 1) where id = old.recipe_id;
  end if;
  return coalesce(new, old);
end;
$$;

create trigger recipe_cooked_log_count_aiu
  after insert or delete on public.recipe_cooked_log
  for each row execute function public.bump_recipe_cooked_count();

-- ─── RLS for new tables ────────────────────────────────────────────────────

alter table public.pantry_items      enable row level security;
alter table public.recipe_cooked_log enable row level security;

create policy pantry_items_self_all on public.pantry_items
  for all to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

create policy recipe_cooked_log_self_all on public.recipe_cooked_log
  for all to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

-- ─── Trend Views ───────────────────────────────────────────────────────────
-- Views aggregate across users. Anyone with Plus/Premium can read them.
-- We don't enforce subscription tier in DB — mobile gates by hasFeature.

-- Product trend: how often a name appears in users' shopping lists,
-- and how many of those got actually purchased (= bought). Last 30 days.
create view public.product_trend_30d as
select
  lower(trim(name)) as name_key,
  max(name) as sample_name,
  count(*)::int as added_count,
  count(*) filter (where purchased_at is not null)::int as purchased_count,
  count(distinct user_id)::int as unique_users,
  max(created_at) as latest_added_at
from public.shopping_list_items
where created_at >= now() - interval '30 days'
group by lower(trim(name))
having count(*) >= 2;

-- Recipe trend: weighted score from planned + cooked + rating.
create view public.recipe_trend_30d as
select
  r.id as recipe_id,
  (r.name ->> 'de') as name_de,
  r.image_url,
  r.meal_type,
  r.category,
  r.difficulty,
  r.cook_time_minutes,
  r.rating,
  r.rating_count,
  r.cooked_count,
  coalesce(planned.cnt, 0)::int as planned_count_30d,
  coalesce(swipes.cnt, 0)::int  as swipe_plan_count_30d,
  coalesce(cooked.cnt, 0)::int  as cooked_count_30d,
  coalesce(unique_planners.cnt, 0)::int as unique_planners_30d
from public.recipes r
left join lateral (
  select count(*) as cnt from public.weekly_plan_entries we
  where we.recipe_id = r.id
    and we.week_start_date >= current_date - interval '30 days'
) planned on true
left join lateral (
  select count(*) as cnt from public.recipe_swipes s
  where s.recipe_id = r.id
    and s.action = 'add_to_plan'
    and s.created_at >= now() - interval '30 days'
) swipes on true
left join lateral (
  select count(*) as cnt from public.recipe_cooked_log c
  where c.recipe_id = r.id
    and c.cooked_at >= now() - interval '30 days'
) cooked on true
left join lateral (
  select count(distinct we.user_id) as cnt from public.weekly_plan_entries we
  where we.recipe_id = r.id
    and we.week_start_date >= current_date - interval '30 days'
) unique_planners on true
where r.status = 'active';

-- ─── Grants ─────────────────────────────────────────────────────────────────
-- Future tables auto-grant per default privileges (set in 20260509000001).
-- For these tables we are explicit too.
grant all privileges on public.pantry_items, public.recipe_cooked_log to service_role;
grant select on public.product_trend_30d, public.recipe_trend_30d to authenticated, service_role;
