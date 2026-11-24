-- Cheffity diet tracking: daily meal log + water log + goal/target columns.
--
-- Builds on the existing diet tables from 20260507000004_planner_shopping_diet.sql
-- (user_body_data, user_progress_entries). This migration adds the "what did I
-- eat / drink today" side of tracking that the existing schema lacked:
--
--   user_meal_log    one row per logged food item (meal or snack) per day
--   user_water_log   one cumulative water total per (user, day)
--
-- plus a few optional goal/target columns on user_body_data so the conservative
-- nutrition calculator (mobile/src/utils/nutritionTargets.ts) can persist what
-- it derived and the user can override it. All new body columns are nullable so
-- existing rows keep working unchanged.
--
-- STAND: am 2026-08-04 auf das Remote-Projekt angewendet.
-- Der Dateiname traegt die beim Apply vergebene Version (20260804021235),
-- vorher 20260531000001.
--
-- Die Migration lag rund zwei Monate ungepusht herum: `user_meal_log` und
-- `user_water_log` existierten remote nicht, wodurch
-- mobile/src/services/dietTrackingApi.ts gegen die Produktivdatenbank ins
-- Leere lief — das Tracking-Feature war schlicht funktionslos.
--
-- Vor dem Apply geprueft: beide Tabellen, beide Enums und alle fuenf neuen
-- user_body_data-Spalten fehlten; die Migration lief also unveraendert durch.
-- Danach verifiziert: RLS aktiv, je eine Policy, je 4 DML-Grants fuer
-- `authenticated`.

-- ─── enums ──────────────────────────────────────────────────────────────────
-- Tracking buckets are intentionally simpler than recipes.meal_type: the food
-- log only needs breakfast/lunch/dinner/snack. A separate enum keeps the recipe
-- meal_type (which carries sweet_baked/drinks) untouched.
create type public.meal_category as enum ('breakfast', 'lunch', 'dinner', 'snack');

-- The user's high-level goal. Drives the conservative calorie/protein hints.
create type public.diet_goal_type as enum ('lose', 'maintain', 'gain', 'recomp');

-- ─── user_body_data: optional goal / target columns ───────────────────────────
alter table public.user_body_data
  add column age                    int             check (age is null or age between 14 and 120),
  add column diet_goal_type         public.diet_goal_type,
  add column training_days_per_week int             check (training_days_per_week is null or training_days_per_week between 0 and 14),
  add column protein_target_g       int             check (protein_target_g is null or protein_target_g between 20 and 400),
  add column water_target_ml        int             check (water_target_ml is null or water_target_ml between 500 and 8000);

-- ─── user_meal_log ────────────────────────────────────────────────────────────
-- One row per logged food item. Nutrition values are stored as logged (already
-- multiplied by the chosen portions for recipe entries) so summing a day is a
-- plain SUM with no portion math at read time. nutrition_estimated mirrors the
-- "Nährwerte sind Schätzwerte" disclaimer — true unless a verified source set it.
create table public.user_meal_log (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  entry_date          date not null,
  meal_category       public.meal_category not null default 'snack',
  name                text not null check (length(trim(name)) > 0),
  -- When the entry came from a recipe we keep the link (set null if the recipe
  -- is later removed) plus the portions used, for display only.
  recipe_id           uuid references public.recipes(id) on delete set null,
  portions            numeric(5,2) check (portions is null or portions between 0.1 and 20),
  calories            numeric(7,1)  check (calories  is null or calories  between 0 and 20000),
  protein_g           numeric(6,1)  check (protein_g is null or protein_g between 0 and 2000),
  carbs_g             numeric(6,1)  check (carbs_g   is null or carbs_g   between 0 and 2000),
  fat_g               numeric(6,1)  check (fat_g     is null or fat_g     between 0 and 2000),
  satiety             int           check (satiety is null or satiety between 1 and 5),
  nutrition_estimated boolean not null default true,
  created_at          timestamptz not null default now()
);

create index user_meal_log_user_date_idx
  on public.user_meal_log (user_id, entry_date desc);

-- ─── user_water_log ─────────────────────────────────────────────────────────
-- One cumulative total per user per day. The +250/+500 quick buttons just bump
-- amount_ml; the goal lives on user_body_data.water_target_ml.
create table public.user_water_log (
  user_id     uuid not null references auth.users(id) on delete cascade,
  entry_date  date not null,
  amount_ml   int  not null default 0 check (amount_ml between 0 and 20000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  primary key (user_id, entry_date)
);

create trigger user_water_log_set_updated_at
  before update on public.user_water_log
  for each row execute function public.set_updated_at();

-- ─── RLS ──────────────────────────────────────────────────────────────────────
alter table public.user_meal_log  enable row level security;
alter table public.user_water_log enable row level security;

create policy user_meal_log_self_all on public.user_meal_log
  for all to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

create policy user_water_log_self_all on public.user_water_log
  for all to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

-- ─── Grants ─────────────────────────────────────────────────────────────────
-- Default privileges (20260509000001) grant SELECT to `authenticated` and ALL
-- to `service_role` on new tables. Mobile writes under the user JWT, so DML must
-- be granted explicitly or Postgres rejects INSERT/UPDATE/DELETE before RLS runs
-- (same fix as 20260519000002 / 20260519000003).
grant all privileges on public.user_meal_log, public.user_water_log to service_role;
grant select, insert, update, delete on public.user_meal_log  to authenticated;
grant select, insert, update, delete on public.user_water_log to authenticated;
