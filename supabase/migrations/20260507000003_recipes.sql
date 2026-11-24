-- Cheffity schema: recipes, ingredients, instructions, swipes, comments.
-- Multilingual fields are jsonb { de, en, tr, it, es, pl } with de required.

-- recipes ------------------------------------------------------------------

create table public.recipes (
  id                uuid primary key default gen_random_uuid(),
  name              jsonb not null,
  intro             jsonb,
  meal_type         public.meal_type not null,
  category          public.deal_category not null default 'other',
  difficulty        public.recipe_difficulty not null default 'medium',
  cook_time_minutes int not null check (cook_time_minutes between 1 and 600),
  default_portions  int not null default 2 check (default_portions between 1 and 12),
  image_url         text,
  status            public.recipe_status not null default 'active',

  -- nutrition per portion
  calories  int     check (calories  is null or calories  >= 0),
  protein_g numeric(6,2) check (protein_g is null or protein_g >= 0),
  carbs_g   numeric(6,2) check (carbs_g   is null or carbs_g   >= 0),
  fat_g     numeric(6,2) check (fat_g     is null or fat_g     >= 0),
  vitamins  jsonb,
  minerals  jsonb,

  -- cached aggregates maintained by triggers on recipe_comments
  rating        numeric(3,2),
  rating_count  int not null default 0,
  comment_count int not null default 0,
  cooked_count  int not null default 0,

  source       text,
  source_ref   text,
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint recipes_name_has_de check (name ? 'de' and length(name ->> 'de') > 0)
);

create index recipes_status_idx          on public.recipes (status) where status = 'active';
create index recipes_meal_type_idx       on public.recipes (meal_type);
create index recipes_category_idx        on public.recipes (category);
create index recipes_difficulty_idx      on public.recipes (difficulty);
create index recipes_rating_idx          on public.recipes (rating desc nulls last);
create index recipes_created_at_idx      on public.recipes (created_at desc);

create trigger recipes_set_updated_at
  before update on public.recipes
  for each row execute function public.set_updated_at();

-- recipe_ingredients -------------------------------------------------------

create table public.recipe_ingredients (
  id                  uuid primary key default gen_random_uuid(),
  recipe_id           uuid not null references public.recipes(id) on delete cascade,
  position            int  not null check (position >= 0),
  name                jsonb not null,
  amount              numeric(10,3) not null check (amount >= 0),
  unit                text not null default '',
  is_potential_deal   boolean not null default true,
  allergens           public.allergen[] not null default '{}',
  is_halal            boolean not null default true,
  contains_alcohol    boolean not null default false,

  constraint recipe_ingredients_name_has_de check (name ? 'de' and length(name ->> 'de') > 0),
  constraint recipe_ingredients_unique_position unique (recipe_id, position) deferrable initially deferred
);

create index recipe_ingredients_recipe_idx on public.recipe_ingredients (recipe_id, position);

-- recipe_instructions ------------------------------------------------------

create table public.recipe_instructions (
  id          uuid primary key default gen_random_uuid(),
  recipe_id   uuid not null references public.recipes(id) on delete cascade,
  step_number int  not null check (step_number > 0),
  text        jsonb not null,

  constraint recipe_instructions_text_has_de check (text ? 'de' and length(text ->> 'de') > 0),
  constraint recipe_instructions_unique_step unique (recipe_id, step_number) deferrable initially deferred
);

create index recipe_instructions_recipe_idx on public.recipe_instructions (recipe_id, step_number);

-- recipe_swipes (event log) ------------------------------------------------

create table public.recipe_swipes (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references auth.users(id) on delete cascade,
  recipe_id       uuid not null references public.recipes(id) on delete cascade,
  action          public.swipe_action not null,
  meal_type       public.meal_type,
  week_start_date date,
  created_at      timestamptz not null default now()
);

create index recipe_swipes_user_recipe_created_idx
  on public.recipe_swipes (user_id, recipe_id, created_at desc);
create index recipe_swipes_recipe_action_idx
  on public.recipe_swipes (recipe_id, action);
create index recipe_swipes_created_at_idx
  on public.recipe_swipes (created_at desc);

-- Latest state per (user, recipe). Useful for hiding banned/favorited recipes.
create view public.user_recipe_state as
  select distinct on (user_id, recipe_id)
    user_id,
    recipe_id,
    action,
    created_at
  from public.recipe_swipes
  order by user_id, recipe_id, created_at desc;

-- recipe_comments ----------------------------------------------------------

create table public.recipe_comments (
  id          uuid primary key default gen_random_uuid(),
  recipe_id   uuid not null references public.recipes(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  rating      numeric(2,1) not null
              check (rating between 0.5 and 5 and (rating * 10)::int % 5 = 0),
  text        text not null check (length(trim(text)) > 0),
  photo_url   text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index recipe_comments_recipe_idx     on public.recipe_comments (recipe_id, created_at desc);
create index recipe_comments_user_idx       on public.recipe_comments (user_id, created_at desc);

create trigger recipe_comments_set_updated_at
  before update on public.recipe_comments
  for each row execute function public.set_updated_at();

-- Trigger: keep recipes.rating / rating_count / comment_count in sync.
create or replace function public.refresh_recipe_aggregates(p_recipe_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.recipes r
  set
    rating        = agg.avg_rating,
    rating_count  = agg.cnt,
    comment_count = agg.cnt
  from (
    select
      avg(rating)::numeric(3,2) as avg_rating,
      count(*)::int             as cnt
    from public.recipe_comments
    where recipe_id = p_recipe_id
  ) agg
  where r.id = p_recipe_id;
$$;

create or replace function public.recipe_comments_after_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.refresh_recipe_aggregates(old.recipe_id);
    return old;
  end if;
  perform public.refresh_recipe_aggregates(new.recipe_id);
  if tg_op = 'UPDATE' and old.recipe_id <> new.recipe_id then
    perform public.refresh_recipe_aggregates(old.recipe_id);
  end if;
  return new;
end;
$$;

create trigger recipe_comments_aggregates_aiud
  after insert or update or delete on public.recipe_comments
  for each row execute function public.recipe_comments_after_change();

-- RLS ----------------------------------------------------------------------

alter table public.recipes              enable row level security;
alter table public.recipe_ingredients   enable row level security;
alter table public.recipe_instructions  enable row level security;
alter table public.recipe_swipes        enable row level security;
alter table public.recipe_comments      enable row level security;

-- Recipes (and ingredients/instructions) are global content.
-- Active recipes are readable by any authenticated user.
-- Hidden ones only by admins. Writes are admin-only.
create policy recipes_public_read on public.recipes
  for select to authenticated
  using (status = 'active' or public.is_admin());

create policy recipes_admin_write on public.recipes
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy recipe_ingredients_read on public.recipe_ingredients
  for select to authenticated
  using (
    exists (
      select 1 from public.recipes r
      where r.id = recipe_ingredients.recipe_id
        and (r.status = 'active' or public.is_admin())
    )
  );

create policy recipe_ingredients_admin_write on public.recipe_ingredients
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy recipe_instructions_read on public.recipe_instructions
  for select to authenticated
  using (
    exists (
      select 1 from public.recipes r
      where r.id = recipe_instructions.recipe_id
        and (r.status = 'active' or public.is_admin())
    )
  );

create policy recipe_instructions_admin_write on public.recipe_instructions
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Swipes: user sees own, admin sees all (for analytics).
create policy recipe_swipes_self_select on public.recipe_swipes
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy recipe_swipes_self_insert on public.recipe_swipes
  for insert to authenticated
  with check (user_id = auth.uid());

-- Comments: any authenticated user can read; users can insert/edit/delete their own; admins moderate.
create policy recipe_comments_read on public.recipe_comments
  for select to authenticated
  using (true);

create policy recipe_comments_self_insert on public.recipe_comments
  for insert to authenticated
  with check (user_id = auth.uid());

create policy recipe_comments_self_update on public.recipe_comments
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy recipe_comments_self_delete on public.recipe_comments
  for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());
