-- Cheffity: scan-run book-keeping for offer-history.
--
-- Background:
--   The offer-history pipeline writes a fresh row per offer at every sync,
--   tagged with a deterministic `snapshot_id`. That answers "what did we
--   observe at minute X" but not "how many sync runs happened this week"
--   or "did the user's One-Click-KI actually finish without errors".
--
--   This migration introduces `offer_scan_runs` as the canonical ledger
--   of sync attempts. One row per snapshot. The backend creates/updates
--   the row from `writeOfferHistory`, so no manual "save history" action
--   is needed by the operator.
--
-- Calendar week:
--   `iso_year` / `iso_week` / `week_start_date` / `week_end_date` are
--   derived from `started_at` (UTC) at insert time. Once a sync starts,
--   its scan-run is anchored to that ISO week — late-arriving completion
--   events do NOT move it into a new week. This matches the user's mental
--   model ("today's scan belongs to KW 22").
--
-- Out of scope:
--   - No cron-trigger here; runs are created by application code.
--   - No backfill for the existing 891 history rows from the first sync.
--     They keep `scan_run_id = null` and don't appear in scan-run stats.

create table public.offer_scan_runs (
  id                     uuid primary key default gen_random_uuid(),

  -- 1:1 with `offer_history.snapshot_id`. Unique → idempotent: a second
  -- writeOfferHistory call for the same snapshot reuses the existing run
  -- instead of creating a duplicate. CHECK requires a non-empty value.
  snapshot_id            text not null
                         check (length(trim(snapshot_id)) > 0)
                         unique,

  -- The action that triggered this scan. Free-text would invite typos in
  -- log filters; constrained to the known origins. `unknown` is the
  -- catch-all for future call sites that haven't been classified yet.
  scan_type              text not null
                         check (scan_type in (
                           'manual_sync',
                           'one_click_ai',
                           'auto_sync',
                           'test',
                           'unknown'
                         )),

  status                 text not null default 'started'
                         check (status in ('started', 'completed', 'failed')),

  -- ISO-8601 week the run belongs to. Derived from started_at on insert
  -- (backend or default expression) and never updated after that.
  iso_year               int  not null check (iso_year between 2020 and 2100),
  iso_week               int  not null check (iso_week between 1 and 53),
  week_start_date        date not null,
  week_end_date          date not null,

  started_at             timestamptz not null default now(),
  completed_at           timestamptz,

  -- Counters mirror the WriteHistoryResult shape, so the dashboard can
  -- render them without re-joining offer_history.
  offers_count           int  not null default 0 check (offers_count           >= 0),
  history_written_count  int  not null default 0 check (history_written_count  >= 0),
  expired_count          int  not null default 0 check (expired_count          >= 0),
  error_count            int  not null default 0 check (error_count            >= 0),
  error_message          text,

  created_at             timestamptz not null default now()
);

-- ─── Indexes ──────────────────────────────────────────────────────────────
-- The two leading admin queries are "last N runs" (started_at desc) and
-- "runs in week X" ((iso_year, iso_week)). A separate week_start_date
-- index supports the calendar-explorer's "by date" navigation cheaply.

create index offer_scan_runs_iso_week_idx
  on public.offer_scan_runs (iso_year, iso_week);

create index offer_scan_runs_week_start_idx
  on public.offer_scan_runs (week_start_date desc);

create index offer_scan_runs_status_idx
  on public.offer_scan_runs (status);

create index offer_scan_runs_started_at_idx
  on public.offer_scan_runs (started_at desc);

-- snapshot_id has its own unique-index automatically from the UNIQUE
-- constraint above, no second index needed.

-- ─── offer_history backlink ───────────────────────────────────────────────
-- ON DELETE SET NULL keeps historic price rows even if a run is purged
-- for whatever reason — analytics like price evolution stay intact.

alter table public.offer_history
  add column scan_run_id uuid
    references public.offer_scan_runs(id) on delete set null;

create index offer_history_scan_run_idx
  on public.offer_history (scan_run_id)
  where scan_run_id is not null;

-- ─── RLS ──────────────────────────────────────────────────────────────────
-- Same posture as offer_history: service-role writes from the backend,
-- admin reads via /api/admin/* (which also goes through service_role).
-- We do NOT grant select to `authenticated` directly — there's nothing
-- on a scan-run that an end user should see.

alter table public.offer_scan_runs enable row level security;

-- Explicit admin-read policy as future-proofing. If a logged-in admin UI
-- ever queries directly with the user's JWT (instead of the backend's
-- service role), this is the gate that lets them through.
create policy offer_scan_runs_admin_read on public.offer_scan_runs
  for select to authenticated
  using (public.is_admin());

grant all privileges on public.offer_scan_runs to service_role;
-- No grant to authenticated — by design.
