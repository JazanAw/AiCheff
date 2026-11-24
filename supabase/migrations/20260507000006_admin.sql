-- Cheffity schema: admin-only systems — activity log, push notifications,
-- feature flags, app secrets, cookbook uploads, AI training runs.

-- activity_log -------------------------------------------------------------

create table public.activity_log (
  id            bigint generated always as identity primary key,
  admin_user_id uuid references auth.users(id),
  admin_email   citext,
  action        text not null,
  target_table  text,
  target_id     text,
  payload       jsonb,
  created_at    timestamptz not null default now()
);

create index activity_log_admin_idx on public.activity_log (admin_user_id, created_at desc);
create index activity_log_action_idx on public.activity_log (action, created_at desc);
create index activity_log_target_idx on public.activity_log (target_table, target_id);

-- RPC: write an activity log entry. Frontends call this from admin panel.
create or replace function public.admin_log_action(
  p_action       text,
  p_target_table text default null,
  p_target_id    text default null,
  p_payload      jsonb default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
  v_email citext;
begin
  if not public.is_admin() then
    raise exception 'admin_log_action: caller is not an admin';
  end if;

  select email into v_email from public.profiles where id = auth.uid();

  insert into public.activity_log (admin_user_id, admin_email, action, target_table, target_id, payload)
  values (auth.uid(), v_email, p_action, p_target_table, p_target_id, p_payload)
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.admin_log_action(text, text, text, jsonb) from public;
grant execute on function public.admin_log_action(text, text, text, jsonb) to authenticated;

-- push_history -------------------------------------------------------------

create table public.push_history (
  id              uuid primary key default gen_random_uuid(),
  sent_by         uuid references auth.users(id),
  audience        public.push_audience not null,
  audience_filter jsonb,
  title           jsonb not null,
  body            jsonb not null,
  scheduled_for   timestamptz,
  sent_at         timestamptz,
  status          public.push_status not null default 'scheduled',
  recipient_count int,
  error_message   text,
  expo_response   jsonb,
  created_at      timestamptz not null default now(),

  constraint push_title_has_de check (title ? 'de' and length(title ->> 'de') > 0),
  constraint push_body_has_de  check (body  ? 'de' and length(body  ->> 'de') > 0)
);

create index push_history_status_idx on public.push_history (status, scheduled_for);
create index push_history_sent_at_idx on public.push_history (sent_at desc);

-- feature_flags ------------------------------------------------------------

create table public.feature_flags (
  key         text primary key,
  enabled     boolean not null default false,
  value       jsonb,
  description text,
  updated_by  uuid references auth.users(id),
  updated_at  timestamptz not null default now()
);

create trigger feature_flags_set_updated_at
  before update on public.feature_flags
  for each row execute function public.set_updated_at();

-- app_secrets --------------------------------------------------------------
-- Stores third-party API keys (Marktguru, Kaufda, TheMealDB, Stripe, Claude, Ollama).
-- Values should be encrypted at rest via Supabase Vault in production. For
-- now this is a plain table locked down to admins; the value column is
-- write-only by convention (no SELECT exposure to clients — admins read via
-- a SECURITY DEFINER RPC if/when needed).

create table public.app_secrets (
  service     text primary key,
  value       text,
  notes       text,
  updated_by  uuid references auth.users(id),
  updated_at  timestamptz not null default now()
);

create trigger app_secrets_set_updated_at
  before update on public.app_secrets
  for each row execute function public.set_updated_at();

insert into public.app_secrets (service) values
  ('marktguru'), ('kaufda'), ('themealdb'), ('stripe'), ('claude'), ('ollama')
on conflict do nothing;

-- App-wide config (e.g., AI provider toggle 'local' | 'claude').
create table public.app_config (
  key         text primary key,
  value       jsonb not null,
  description text,
  updated_by  uuid references auth.users(id),
  updated_at  timestamptz not null default now()
);

create trigger app_config_set_updated_at
  before update on public.app_config
  for each row execute function public.set_updated_at();

insert into public.app_config (key, value, description) values
  ('ai_provider', '"local"'::jsonb, 'AI provider used by mobile app: "local" or "claude"')
on conflict do nothing;

-- cookbook_uploads ---------------------------------------------------------

create table public.cookbook_uploads (
  id                 uuid primary key default gen_random_uuid(),
  uploaded_by        uuid references auth.users(id),
  file_url           text not null,
  file_type          text not null check (file_type in ('pdf', 'jpg', 'png')),
  status             public.cookbook_status not null default 'pending',
  extracted_payload  jsonb,
  saved_recipe_id    uuid references public.recipes(id) on delete set null,
  error_message      text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index cookbook_uploads_status_idx on public.cookbook_uploads (status, created_at desc);

create trigger cookbook_uploads_set_updated_at
  before update on public.cookbook_uploads
  for each row execute function public.set_updated_at();

-- ai_training_runs ---------------------------------------------------------
-- Log of AI retraining triggers from the admin panel.

create table public.ai_training_runs (
  id            uuid primary key default gen_random_uuid(),
  triggered_by  uuid references auth.users(id),
  status        public.deal_scan_status not null default 'running',
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  swipe_count   int,
  log           jsonb,
  error_message text
);

create index ai_training_runs_started_idx on public.ai_training_runs (started_at desc);

-- RLS: every admin table is admin-only.
alter table public.activity_log       enable row level security;
alter table public.push_history       enable row level security;
alter table public.feature_flags      enable row level security;
alter table public.app_secrets        enable row level security;
alter table public.app_config         enable row level security;
alter table public.cookbook_uploads   enable row level security;
alter table public.ai_training_runs   enable row level security;

create policy activity_log_admin_only on public.activity_log
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy push_history_admin_only on public.push_history
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- feature_flags + app_config: admins write; all authenticated users can READ
-- (the mobile app needs to read flag/config values).
create policy feature_flags_read on public.feature_flags
  for select to authenticated
  using (true);

create policy feature_flags_admin_write on public.feature_flags
  for insert to authenticated with check (public.is_admin());
create policy feature_flags_admin_update on public.feature_flags
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy feature_flags_admin_delete on public.feature_flags
  for delete to authenticated using (public.is_admin());

create policy app_config_read on public.app_config
  for select to authenticated
  using (true);

create policy app_config_admin_write on public.app_config
  for insert to authenticated with check (public.is_admin());
create policy app_config_admin_update on public.app_config
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy app_config_admin_delete on public.app_config
  for delete to authenticated using (public.is_admin());

-- app_secrets: admin-only, no public read at all.
create policy app_secrets_admin_only on public.app_secrets
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy cookbook_uploads_admin_only on public.cookbook_uploads
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy ai_training_runs_admin_only on public.ai_training_runs
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());
