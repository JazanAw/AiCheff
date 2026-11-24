-- Cheffity: extra recipe metadata to support the local seed import.
--
-- Background:
--   The local seed format (backend/src/recipeSeed.ts +
--   data/recipes/recipes_seed.example.json) carries fields that the `recipes`
--   table did not have a typed home for yet. This migration adds them so a
--   later import can persist a recipe in full instead of dropping metadata.
--
-- Safety:
--   - Additive only: `add column if not exists`, no drops, no data deletion.
--   - Array columns default to '{}' so the NOT NULL backfill on existing rows
--     is empty (no behaviour change for current recipes).
--   - `halal_status` mirrors the seed enum via a CHECK; NULL stays allowed
--     ("unclear / not set").
--   - `image_url` already exists (20260507000003_recipes.sql); the IF NOT
--     EXISTS guard makes re-declaring it a harmless no-op and keeps this file
--     a complete description of the seed-metadata surface.
--   - NOT executed remotely as part of this change. Push deliberately later
--     with `npx supabase db push` after review.

alter table public.recipes
  add column if not exists prep_time_minutes integer
    check (prep_time_minutes is null or prep_time_minutes between 0 and 600),
  add column if not exists cuisine text,
  add column if not exists tags text[] not null default '{}',
  add column if not exists diet_flags text[] not null default '{}',
  add column if not exists halal_status text
    check (halal_status is null or halal_status in ('halal', 'not_halal', 'unclear')),
  add column if not exists halal_notes text,
  add column if not exists image_url text;

-- Tag filtering ("show me vegan / quick recipes") is the obvious future query.
-- A GIN index keeps it cheap; created lazily and idempotently.
create index if not exists recipes_tags_gin_idx
  on public.recipes using gin (tags);

comment on column public.recipes.prep_time_minutes is
  'Preparation time in minutes (seed: prep_time_minutes). cook_time_minutes stays the active/cooking time.';
comment on column public.recipes.tags is
  'Free-form discovery tags from the seed (e.g. schnell, vegan, frühstück).';
comment on column public.recipes.diet_flags is
  'Diet markers from the seed (e.g. vegetarian, vegan, glutenfrei).';
comment on column public.recipes.halal_status is
  'halal | not_halal | unclear — recipe-level halal classification from the seed.';
