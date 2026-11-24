-- Grant DML to `authenticated` on user-owned tables created in
-- 20260509000003_pantry_and_trends.sql.
--
-- Background: 20260509000001_grant_service_role.sql sets default privileges
-- for the `authenticated` role to SELECT only:
--
--     alter default privileges in schema public
--       grant select on tables to authenticated;
--
-- So when pantry_items / recipe_cooked_log were created later, they picked
-- up SELECT for `authenticated` but no INSERT/UPDATE/DELETE. Postgres then
-- rejects mobile inserts with "permission denied for table pantry_items"
-- BEFORE the RLS policy `pantry_items_self_all` even gets a chance to allow
-- the row through. Row-level security still enforces "user_id = auth.uid()"
-- — these grants only let RLS do its job.
--
-- Scope: only the two tables that have a "*_self_all" RLS policy and are
-- written by the mobile app under the authenticated user's JWT. We do NOT
-- grant DML on the rest of public.* — those are either read-only for app
-- users (recipes, deals, …) or write-only via service_role (webhooks).

grant select, insert, update, delete on public.pantry_items      to authenticated;
grant select, insert, update, delete on public.recipe_cooked_log to authenticated;
