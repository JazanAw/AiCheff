-- Cheffity schema: admin-dashboard views and RPCs.
-- Views run with the querying user's privileges, so each view is RLS-aware.
-- RPCs that need to read auth.users are SECURITY DEFINER + admin-checked.

-- Active subscribers per tier (public to admins via RLS on subscriptions).
create view public.subscriber_counts as
  select
    tier,
    count(*) filter (where status = 'active') as active_count,
    count(*) as total_count
  from public.subscriptions
  group by tier;

-- Recipes-per-week analytics: aggregates of swipes in the last 7 days.
create view public.recipe_swipe_stats_week as
  select
    s.recipe_id,
    count(*) filter (where s.action = 'add_to_plan') as planned_count,
    count(*) filter (where s.action = 'not_now')    as not_now_count,
    count(*) filter (where s.action = 'never')      as never_count,
    count(*) filter (where s.action = 'favorite')   as favorite_count,
    count(distinct s.user_id) as unique_users
  from public.recipe_swipes s
  where s.created_at >= now() - interval '7 days'
  group by s.recipe_id;

-- Combined per-recipe analytics for the admin "Swipe analytics" table.
create view public.recipe_analytics as
  select
    r.id,
    r.name ->> 'de' as name_de,
    r.meal_type,
    r.category,
    r.difficulty,
    r.status,
    r.rating,
    r.rating_count,
    r.comment_count,
    r.cooked_count,
    coalesce(planned.cnt, 0) as planned_total,
    coalesce(notnow.cnt, 0)  as not_now_total,
    coalesce(never_cnt.cnt, 0) as never_total,
    coalesce(fav.cnt, 0)     as favorite_total
  from public.recipes r
  left join lateral (
    select count(*) as cnt from public.recipe_swipes
    where recipe_id = r.id and action = 'add_to_plan'
  ) planned on true
  left join lateral (
    select count(*) as cnt from public.recipe_swipes
    where recipe_id = r.id and action = 'not_now'
  ) notnow on true
  left join lateral (
    select count(*) as cnt from public.recipe_swipes
    where recipe_id = r.id and action = 'never'
  ) never_cnt on true
  left join lateral (
    select count(*) as cnt from public.recipe_swipes
    where recipe_id = r.id and action = 'favorite'
  ) fav on true;

-- Deals scanned this week.
create view public.deals_scanned_this_week as
  select count(*) as cnt
  from public.deals
  where scanned_at >= date_trunc('week', now());

-- RPC: admin dashboard stats (single round trip).
-- auth.users.count requires SECURITY DEFINER access since auth schema is restricted.
create or replace function public.admin_dashboard_stats()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not public.is_admin() then
    raise exception 'admin_dashboard_stats: caller is not an admin';
  end if;

  select jsonb_build_object(
    'total_users',           (select count(*) from auth.users),
    'active_plus',           (select count(*) from public.subscriptions where tier = 'plus'    and status = 'active'),
    'active_premium',        (select count(*) from public.subscriptions where tier = 'premium' and status = 'active'),
    'total_recipes',         (select count(*) from public.recipes where status = 'active'),
    'deals_scanned_week',    (select count(*) from public.deals where scanned_at >= date_trunc('week', now())),
    'most_swiped_this_week', (
      select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (
        select
          r.id,
          r.name ->> 'de' as name_de,
          coalesce(stats.planned_count, 0) as planned_count
        from public.recipe_swipe_stats_week stats
        join public.recipes r on r.id = stats.recipe_id
        order by stats.planned_count desc nulls last
        limit 10
      ) t
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.admin_dashboard_stats() from public;
grant execute on function public.admin_dashboard_stats() to authenticated;

-- RPC: list users with their subscription tier (joins auth.users with profiles).
-- Returns paged results for the admin user list.
create or replace function public.admin_list_users(
  p_search   text default null,
  p_tier     public.subscription_tier default null,
  p_country  char(2) default null,
  p_limit    int default 50,
  p_offset   int default 0
)
returns table (
  id              uuid,
  email           citext,
  display_name    text,
  language        public.language_code,
  country_code    char(2),
  tier            public.subscription_tier,
  status          public.subscription_status,
  banned          boolean,
  last_active_at  timestamptz,
  created_at      timestamptz,
  total_count     bigint
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_list_users: caller is not an admin';
  end if;

  return query
  with filtered as (
    select
      p.id,
      p.email,
      p.display_name,
      p.language,
      p.country_code,
      coalesce(s.tier,   'free')   as tier,
      coalesce(s.status, 'active') as status,
      p.banned,
      p.last_active_at,
      p.created_at
    from public.profiles p
    left join public.subscriptions s on s.user_id = p.id
    where (p_search  is null or p.email ilike '%' || p_search || '%' or p.display_name ilike '%' || p_search || '%')
      and (p_tier    is null or coalesce(s.tier, 'free') = p_tier)
      and (p_country is null or p.country_code = p_country)
  ),
  counted as (
    select count(*) as total from filtered
  )
  select
    f.id, f.email, f.display_name, f.language, f.country_code,
    f.tier, f.status, f.banned, f.last_active_at, f.created_at,
    counted.total
  from filtered f
  cross join counted
  order by f.created_at desc
  limit p_limit offset p_offset;
end;
$$;

revoke all on function public.admin_list_users(text, public.subscription_tier, char, int, int) from public;
grant execute on function public.admin_list_users(text, public.subscription_tier, char, int, int) to authenticated;

-- RPC: change a user's subscription tier from the admin panel (also logs the action).
create or replace function public.admin_set_subscription_tier(
  p_user_id uuid,
  p_tier    public.subscription_tier,
  p_reason  text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_set_subscription_tier: caller is not an admin';
  end if;

  insert into public.subscriptions (user_id, tier, status, set_by_admin)
  values (p_user_id, p_tier, 'active', true)
  on conflict (user_id) do update
    set tier = excluded.tier,
        status = 'active',
        set_by_admin = true,
        updated_at = now();

  perform public.admin_log_action(
    'subscription.set_tier',
    'subscriptions',
    p_user_id::text,
    jsonb_build_object('tier', p_tier, 'reason', p_reason)
  );
end;
$$;

revoke all on function public.admin_set_subscription_tier(uuid, public.subscription_tier, text) from public;
grant execute on function public.admin_set_subscription_tier(uuid, public.subscription_tier, text) to authenticated;

-- RPC: ban / unban a user.
create or replace function public.admin_set_user_banned(
  p_user_id uuid,
  p_banned  boolean,
  p_reason  text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_set_user_banned: caller is not an admin';
  end if;

  update public.profiles
  set banned        = p_banned,
      banned_reason = case when p_banned then p_reason else null end,
      banned_at     = case when p_banned then now()    else null end
  where id = p_user_id;

  perform public.admin_log_action(
    case when p_banned then 'user.ban' else 'user.unban' end,
    'profiles',
    p_user_id::text,
    jsonb_build_object('reason', p_reason)
  );
end;
$$;

revoke all on function public.admin_set_user_banned(uuid, boolean, text) from public;
grant execute on function public.admin_set_user_banned(uuid, boolean, text) to authenticated;
