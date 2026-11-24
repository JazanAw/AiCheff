-- Cheffity: recipe provenance + review/AI-notice metadata.
--
-- Background:
--   Before we import public-domain cookbooks or persist AI-generated recipes,
--   `public.recipes` needs typed provenance and a review-state field so the
--   mobile UI can show "Geprüft" / "KI-Vorschlag" / "Gemeinfreie Quelle" and
--   surface the safety notice on AI-derived content.
--
--   The original table already has two free-text columns `source` and
--   `source_ref` (20260507000003_recipes.sql) that were never enforced and
--   not consistently populated. We leave them in place to avoid breaking any
--   tooling that still writes them, but the new typed columns are the
--   contract going forward.
--
-- Defaults & legacy rows:
--   Adding NOT-NULL enum columns with DEFAULT triggers a backfill that
--   labels every existing row as:
--     source_type          = 'human_verified'
--     verification_status  = 'published'
--     ai_notice_required   = false
--   That mirrors what the old recipe set actually is (manually authored,
--   live). No data migration step needed beyond the DEFAULT.
--
-- Out of scope for this migration:
--   - No public-domain import pipeline.
--   - No AI-recipe generation pipeline.
--   - No FK to a sources table — we keep the metadata denormalized on the
--     recipe row until volume justifies a `recipe_sources` table.

-- ─── Enums ────────────────────────────────────────────────────────────────

create type public.recipe_source_type as enum (
  'human_verified',
  'public_domain_adapted',
  'ai_generated',
  'ai_adapted'
);

create type public.recipe_verification_status as enum (
  'draft',
  'reviewed',
  'published'
);

-- ─── Columns ─────────────────────────────────────────────────────────────

alter table public.recipes
  add column source_type          public.recipe_source_type
    not null default 'human_verified',
  add column verification_status  public.recipe_verification_status
    not null default 'published',
  -- Bibliographic metadata. Optional even for public_domain_adapted, because
  -- partial provenance is still better than none — the UI degrades gracefully.
  add column source_title         text,
  add column source_author        text,
  add column source_year          int
    check (source_year is null or source_year between 1500 and 2100),
  add column source_url           text,
  add column source_license       text,
  -- Forces the mobile "AI safety notice" banner even on rows that aren't
  -- typed as ai_*. Lets editors flag a human-verified recipe that still
  -- needs the disclaimer (e.g. modernised dosing, allergens recomputed
  -- against external data).
  add column ai_notice_required   boolean not null default false,
  -- Free-form caveat surfaced to the user. Short, allergen/cooking-temp
  -- nudges; not a generic disclaimer.
  add column safety_notes         text;

-- ─── Indexes ──────────────────────────────────────────────────────────────
-- "Show me drafts" and "show me what needs review" are the two admin queries
-- the new column unlocks. Both are admin-only paths, but a partial index
-- keeps them cheap regardless of how many published rows accumulate.

create index recipes_verification_status_idx
  on public.recipes (verification_status)
  where verification_status <> 'published';

-- The source_type filter is useful for the admin "list AI recipes" view but
-- only meaningful once we have non-human rows; a plain b-tree is cheap and
-- avoids a second migration when the first ai_* row lands.
create index recipes_source_type_idx
  on public.recipes (source_type);

-- ─── RLS impact ──────────────────────────────────────────────────────────
-- Existing `recipes_public_read` policy already filters on `status = 'active'`
-- plus admin override. `verification_status` is intentionally NOT in that
-- filter for now — a non-admin user could still see a `draft` row if its
-- `status` is 'active'. Admin tooling should keep drafts hidden via
-- `status = 'hidden'` until reviewed; the verification field is metadata for
-- the admin UI, not a second gate. Revisit if/when we start using
-- verification_status='draft' for visibility decisions.
