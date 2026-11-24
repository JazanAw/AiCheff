-- Schliesst die Advisor-WARNs 0011 (function_search_path_mutable) und
-- 0028 (anon_security_definer_function_executable).
--
-- URSACHE
-- -------
-- Postgres vergibt EXECUTE auf neu angelegte Funktionen implizit an PUBLIC.
-- Dadurch waren auch reine Trigger-Funktionen ueber PostgREST als
-- /rest/v1/rpc/<name> erreichbar — teils ohne Login (Rolle `anon`).
--
-- WICHTIG: Ein `revoke ... from anon, authenticated` allein genuegt NICHT.
-- Es entfernt die PUBLIC-Vergabe nicht, und `has_function_privilege` meldet
-- danach weiterhin true. Beim ersten Versuch genau darauf hereingefallen —
-- der Entzug muss explizit `from public` enthalten.
--
-- NACHGEWIESEN VOR DEM EINGRIFF
-- Der Entzug von EXECUTE verhindert das Feuern eines Triggers nicht.
-- Test auf public.profiles: nach
--   revoke execute on function public.set_updated_at() from public
-- war has_function_privilege('authenticated', ...) = false, der UPDATE als
-- `authenticated` lief trotzdem durch und updated_at wurde vom Trigger
-- gesetzt. Postgres prueft die EXECUTE-ACL beim CREATE TRIGGER, nicht beim
-- Feuern. Nach dem Apply auf dem Produktivstand erneut verifiziert.

-- 1) Reine Trigger-Funktionen: von aussen nicht aufrufbar --------------------
-- set_updated_at haengt an 15 Triggern, die drei anderen an je einem.
revoke execute on function public.set_updated_at()                from public, anon, authenticated;
revoke execute on function public.handle_new_user()               from public, anon, authenticated;
revoke execute on function public.recipe_comments_after_change()  from public, anon, authenticated;
revoke execute on function public.bump_recipe_cooked_count()      from public, anon, authenticated;

-- 2) Event-Trigger-Funktion -------------------------------------------------
-- rls_auto_enable() ist `returns event_trigger` und ueber PostgREST ohnehin
-- nicht sinnvoll aufrufbar. Der Entzug ist Hygiene, kein Verhaltenswechsel.
-- Die Funktion selbst ist ein Schutzmechanismus: sie aktiviert RLS
-- automatisch auf jeder neu angelegten Tabelle in `public`.
revoke execute on function public.rls_auto_enable()               from public, anon, authenticated;

-- 3) refresh_recipe_aggregates: nur intern benoetigt -------------------------
-- Wird ausschliesslich aus recipe_comments_after_change() aufgerufen. Diese
-- ist SECURITY DEFINER, der interne Aufruf laeuft also mit Owner-Rechten und
-- ist vom Entzug nicht betroffen. Weder Mobile-App noch Backend rufen sie per
-- RPC auf (geprueft: die App nutzt genau zwei RPCs, admin_dashboard_stats und
-- is_admin; das Backend gar keine).
revoke execute on function public.refresh_recipe_aggregates(uuid) from public, anon, authenticated;

-- 4) Fehlender search_path ---------------------------------------------------
-- Ohne festen search_path kann ein Aufrufer per SET search_path eigene
-- Objekte unterschieben. Bei set_updated_at (15 Trigger) die relevantere der
-- beiden Stellen; public.tx ist ein IMMUTABLE i18n-Helfer und SECURITY
-- INVOKER, dort eher Formsache.
alter function public.set_updated_at()  set search_path = public;
alter function public.tx(jsonb, text)   set search_path = public;

-- BEWUSST UNVERAENDERT GELASSEN
-- -----------------------------
-- Diese drei Gruppen bleiben fuer `authenticated` ausfuehrbar. Der Advisor
-- meldet sie weiterhin unter Lint 0029 — das ist hier akzeptiert, nicht
-- uebersehen:
--
--   public.is_admin(uuid)
--     RLS-Policies quer durch die Datenbank rufen sie im Kontext des
--     Aufrufers auf. Ein Entzug wuerde die RLS praktisch ueberall brechen.
--     Restrisiko: ein eingeloggter Nutzer kann per RPC abfragen, ob eine
--     beliebige UUID Admin ist. Reiner Informationsabfluss, kein Schreibweg.
--
--   public.product_trend_30d_data() / public.recipe_trend_30d_data()
--     Die Views product_trend_30d und recipe_trend_30d sind security_invoker
--     und rufen diese Funktionen als Aufrufer auf. Die Mobile-App liest genau
--     diese Views (mobile/src/services/trendsApi.ts) — ein Entzug wuerde die
--     Trend-Anzeige brechen.
--
--   public.admin_dashboard_stats(), admin_list_users(), admin_log_action(),
--   admin_set_subscription_tier(), admin_set_user_banned()
--     Alle fuenf pruefen intern is_admin() und werfen sonst. Verifiziert: ein
--     Nicht-Admin auf admin_set_subscription_tier erhaelt
--     "caller is not an admin". Der Aufrufweg ist offen, die Wirkung nicht.
