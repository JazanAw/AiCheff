-- Security Advisor fixes (Critical):
--   1. "Security Definer View" for 7 views  → run them with security_invoker.
--   2. "Auth RLS Initialization Plan" for public.profiles → wrap auth.uid()
--      in a scalar subselect so it is evaluated once per query, not per row.
--
-- Guard rails honoured here:
--   * RLS is NEVER disabled.
--   * Intentional SECURITY DEFINER admin RPCs (admin_dashboard_stats,
--     admin_list_users, admin_set_*, is_admin, handle_new_user, …) are NOT
--     touched — they purposely read auth.users / cross-user data.
--   * App access stays logically identical (same view names, columns, grants).

-- ─────────────────────────────────────────────────────────────────────────
-- PART 1 — Plain views: switch to security_invoker.
--
-- These either are admin-only (admins keep full access via is_admin() /
-- service_role) or are already filtered per-user on the client. With
-- security_invoker the view respects the querying user's RLS instead of the
-- view owner's — which is exactly what the advisor wants and matches how the
-- app already uses them:
--   * recipe_analytics / recipe_swipe_stats_week / subscriber_counts /
--     deals_scanned_this_week — admin dashboard only. admin_dashboard_stats()
--     is SECURITY DEFINER and keeps seeing everything; direct reads require
--     is_admin() / service_role.
--   * user_recipe_state — swipesApi already does `.eq('user_id', <self>)`;
--     invoker just makes the DB enforce what the client already intended.
-- ALTER VIEW preserves the view body and all existing grants.
-- ─────────────────────────────────────────────────────────────────────────

alter view public.recipe_analytics        set (security_invoker = true);
alter view public.recipe_swipe_stats_week  set (security_invoker = true);
alter view public.subscriber_counts        set (security_invoker = true);
alter view public.deals_scanned_this_week  set (security_invoker = true);
alter view public.user_recipe_state        set (security_invoker = true);

-- ─────────────────────────────────────────────────────────────────────────
-- PART 2 — Cross-user trend views: security_invoker + SECURITY DEFINER
-- aggregate function.
--
-- recipe_trend_30d and product_trend_30d intentionally aggregate ACROSS all
-- users and are read by the mobile client (authenticated). A plain
-- security_invoker view would collapse them to the caller's own rows (the
-- base tables are per-user RLS) and break the trend feature.
--
-- Fix: the view becomes security_invoker=true (advisor satisfied) but selects
-- from a dedicated SECURITY DEFINER function that performs the cross-user
-- aggregation and returns ONLY aggregate columns — no raw per-user rows leak.
-- View name, columns and grants stay identical → trendsApi is unchanged.
-- ─────────────────────────────────────────────────────────────────────────

-- recipe_trend_30d -----------------------------------------------------------

create or replace function public.recipe_trend_30d_data()
returns table (
  recipe_id            uuid,
  name_de              text,
  image_url            text,
  meal_type            public.meal_type,
  category             public.deal_category,
  difficulty           public.recipe_difficulty,
  cook_time_minutes    int,
  rating               numeric,
  rating_count         int,
  cooked_count         int,
  planned_count_30d    int,
  swipe_plan_count_30d int,
  cooked_count_30d     int,
  unique_planners_30d  int
)
language sql
stable
security definer
set search_path = public
as $$
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
$$;

revoke all on function public.recipe_trend_30d_data() from public;
grant execute on function public.recipe_trend_30d_data() to authenticated, service_role;

drop view if exists public.recipe_trend_30d;
create view public.recipe_trend_30d with (security_invoker = true) as
  select * from public.recipe_trend_30d_data();
grant select on public.recipe_trend_30d to authenticated, service_role;

-- product_trend_30d ----------------------------------------------------------

create or replace function public.product_trend_30d_data()
returns table (
  name_key        text,
  sample_name     text,
  added_count     int,
  purchased_count int,
  unique_users    int,
  latest_added_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
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
$$;

revoke all on function public.product_trend_30d_data() from public;
grant execute on function public.product_trend_30d_data() to authenticated, service_role;

drop view if exists public.product_trend_30d;
create view public.product_trend_30d with (security_invoker = true) as
  select * from public.product_trend_30d_data();
grant select on public.product_trend_30d to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- PART 3 — public.profiles RLS: initplan optimisation.
--
-- Logic is unchanged. Each per-row auth.uid() becomes (select auth.uid()) so
-- Postgres folds it into a one-time InitPlan, and is_admin() is called with
-- an explicit (select auth.uid()) and wrapped in a scalar subselect so it too
-- runs once per query instead of once per row.
-- ALTER POLICY keeps the role list (authenticated) and command unchanged.
-- ─────────────────────────────────────────────────────────────────────────

alter policy profiles_self_select on public.profiles
  using (
    id = (select auth.uid())
    or (select public.is_admin((select auth.uid())))
  );

alter policy profiles_self_update on public.profiles
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

alter policy profiles_admin_update on public.profiles
  using ((select public.is_admin((select auth.uid()))))
  with check ((select public.is_admin((select auth.uid()))));

alter policy profiles_admin_delete on public.profiles
  using ((select public.is_admin((select auth.uid()))));
