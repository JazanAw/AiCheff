-- Grant service_role full access to everything in the public schema.
-- Migrations created tables owned by `postgres`, but service_role wasn't
-- explicitly granted, so PostgREST sees 403 "permission denied" when called
-- with the service-role key. Standard Supabase setups grant this by default;
-- we restore that here.

grant usage on schema public to service_role;

grant all privileges on all tables    in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

-- Tables / sequences / functions created in the future automatically pick
-- up the same grants. Run for both postgres (typical migration author) and
-- supabase_admin (Supabase Dashboard SQL editor).
alter default privileges in schema public
  grant all privileges on tables to service_role;
alter default privileges in schema public
  grant all privileges on sequences to service_role;
alter default privileges in schema public
  grant execute on functions to service_role;

-- Also include authenticated for read-side fairness on app-level reads
-- (RLS still enforces row-level visibility per policy).
grant usage on schema public to authenticated;
grant select on all tables in schema public to authenticated;

alter default privileges in schema public
  grant select on tables to authenticated;
