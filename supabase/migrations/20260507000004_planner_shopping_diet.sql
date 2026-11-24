-- Cheffity schema: weekly planner, shopping list, diet tracking.

-- weekly_plan_entries ------------------------------------------------------
-- One row per (user, week, day, meal_type).
-- week_start_date is the Monday of the week.

create table public.weekly_plan_entries (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  week_start_date   date not null,
  day_of_week       int  not null check (day_of_week between 0 and 6),
  meal_type         public.meal_type not null,
  recipe_id         uuid not null references public.recipes(id) on delete cascade,
  portion_override  int check (portion_override is null or portion_override between 1 and 12),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint weekly_plan_unique_slot
    unique (user_id, week_start_date, day_of_week, meal_type)
);

create index weekly_plan_user_week_idx
  on public.weekly_plan_entries (user_id, week_start_date desc);

create trigger weekly_plan_entries_set_updated_at
  before update on public.weekly_plan_entries
  for each row execute function public.set_updated_at();

-- shopping_list_items ------------------------------------------------------

create table public.shopping_list_items (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null check (length(trim(name)) > 0),
  quantity    numeric(10,3) not null default 1 check (quantity > 0),
  unit        text not null default '',
  store_name  text,
  price       numeric(10,2) check (price is null or price >= 0),
  deal_id     uuid,
  recipe_id   uuid references public.recipes(id) on delete set null,
  checked     boolean not null default false,
  is_manual   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index shopping_list_user_idx
  on public.shopping_list_items (user_id, created_at desc);

create trigger shopping_list_items_set_updated_at
  before update on public.shopping_list_items
  for each row execute function public.set_updated_at();

-- user_body_data (Premium diet tracking) -----------------------------------

create table public.user_body_data (
  user_id                  uuid primary key references auth.users(id) on delete cascade,
  gender                   public.gender,
  height_cm                int  check (height_cm is null or height_cm between 80 and 250),
  weight_kg                numeric(5,2) check (weight_kg is null or weight_kg between 25 and 400),
  body_fat_percent         numeric(4,1) check (body_fat_percent is null or body_fat_percent between 2 and 70),
  activity_level           public.activity_level,
  target_weight_kg         numeric(5,2) check (target_weight_kg is null or target_weight_kg between 25 and 400),
  target_body_fat_percent  numeric(4,1) check (target_body_fat_percent is null or target_body_fat_percent between 2 and 70),
  daily_calorie_target     int check (daily_calorie_target is null or daily_calorie_target between 800 and 8000),
  auto_calculate_calories  boolean not null default true,
  goal_mode_enabled        boolean not null default false,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create trigger user_body_data_set_updated_at
  before update on public.user_body_data
  for each row execute function public.set_updated_at();

-- user_progress_entries ----------------------------------------------------

create table public.user_progress_entries (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  entry_date        date not null,
  weight_kg         numeric(5,2) check (weight_kg is null or weight_kg between 25 and 400),
  body_fat_percent  numeric(4,1) check (body_fat_percent is null or body_fat_percent between 2 and 70),
  notes             text,
  created_at        timestamptz not null default now(),

  constraint user_progress_unique_day unique (user_id, entry_date)
);

create index user_progress_user_date_idx
  on public.user_progress_entries (user_id, entry_date desc);

-- RLS ----------------------------------------------------------------------

alter table public.weekly_plan_entries    enable row level security;
alter table public.shopping_list_items    enable row level security;
alter table public.user_body_data         enable row level security;
alter table public.user_progress_entries  enable row level security;

create policy weekly_plan_self_all on public.weekly_plan_entries
  for all to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

create policy shopping_list_self_all on public.shopping_list_items
  for all to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

create policy user_body_data_self_all on public.user_body_data
  for all to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

create policy user_progress_self_all on public.user_progress_entries
  for all to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());
