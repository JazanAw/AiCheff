-- Grant DML to `authenticated` on the remaining user-owned tables.
--
-- Same root cause as 20260519000002_pantry_authenticated_grants.sql:
-- 20260509000001_grant_service_role.sql set default privileges to SELECT
-- only for the `authenticated` role, so every user-write table created
-- before or after that gets SELECT only and fails with
-- "permission denied for table <name>" on INSERT/UPDATE/DELETE under the
-- user's JWT — BEFORE RLS even runs.
--
-- 20260519000002 covered pantry_items + recipe_cooked_log. This migration
-- covers the rest. Grants are scoped per table to match exactly what each
-- table's RLS policy allows. RLS still enforces "user_id = auth.uid()"
-- (or admin / public-read where applicable) — these grants only let RLS
-- get a chance to evaluate.
--
-- Audit basis (pg_policy):
--   shopping_list_items   self_all (*)                    → SELECT, INSERT, UPDATE, DELETE
--   weekly_plan_entries   self_all (*)                    → SELECT, INSERT, UPDATE, DELETE
--   user_body_data        self_all (*)                    → SELECT, INSERT, UPDATE, DELETE
--   user_progress_entries self_all (*)                    → SELECT, INSERT, UPDATE, DELETE
--   user_push_tokens      self_select/insert/update/delete → SELECT, INSERT, UPDATE, DELETE
--   recipe_comments       read + self_insert/update/delete → SELECT, INSERT, UPDATE, DELETE
--   user_preferences      self_select + self_update + self_upsert → SELECT, INSERT, UPDATE
--                                                          (no DELETE: row is permanent per user)
--   profiles              self_select + self_update        → SELECT, UPDATE
--                                                          (no INSERT: rows created by auth trigger;
--                                                           no self DELETE: admin path only)
--   recipe_swipes         self_select + self_insert        → SELECT, INSERT
--                                                          (history is append-only by design)
--
-- Bewusst NICHT: `grant all on all tables in schema public to authenticated`.
-- Das würde z. B. direkten Mobile-INSERT auf deals/recipes/subscriptions
-- erlauben — RLS würde es zwar in den meisten Fällen blocken, aber das
-- Default-Posture „SELECT für app-User, Writes nur via service_role oder
-- self-RLS-Tabellen" soll bleiben.

grant select, insert, update, delete on public.shopping_list_items   to authenticated;
grant select, insert, update, delete on public.weekly_plan_entries   to authenticated;
grant select, insert, update, delete on public.user_body_data        to authenticated;
grant select, insert, update, delete on public.user_progress_entries to authenticated;
grant select, insert, update, delete on public.user_push_tokens      to authenticated;
grant select, insert, update, delete on public.recipe_comments       to authenticated;

grant select, insert, update          on public.user_preferences     to authenticated;
grant select,         update          on public.profiles             to authenticated;
grant select, insert                  on public.recipe_swipes        to authenticated;
