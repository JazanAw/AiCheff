-- Deal favorites — the heart toggle on the redesigned Angebote screen.
--
-- ID note: deals shown in the mobile app come from the backend Express API
-- (/api/offers), whose ids are external/source ids (e.g. "mg_21652062",
-- "offer_ab12cd") — NOT the public.deals.id UUID. So `deal_id` is `text` and
-- intentionally has NO FK to public.deals: it stores exactly the id the mobile
-- app holds for the offer (Deal.id). This mirrors how shopping_list_items
-- already keeps deal_id nullable/text-tolerant for non-UUID backend ids.
--
-- A denormalized snapshot of the offer (name/store/price) is kept so a favorite
-- can still be rendered after the underlying weekly offer rotates out.

create table public.deal_favorites (
  user_id      uuid not null references auth.users(id) on delete cascade,
  deal_id      text not null check (length(trim(deal_id)) > 0),
  -- Optional snapshot so favorites survive offer rotation. All nullable.
  deal_name    text,
  store_name   text,
  current_price numeric(10,2) check (current_price is null or current_price >= 0),
  image_url    text,
  created_at   timestamptz not null default now(),

  primary key (user_id, deal_id)
);

create index deal_favorites_user_idx
  on public.deal_favorites (user_id, created_at desc);

-- RLS: a user only ever sees/writes their own favorites; admins may read all.
alter table public.deal_favorites enable row level security;

create policy deal_favorites_self_select on public.deal_favorites
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy deal_favorites_self_insert on public.deal_favorites
  for insert to authenticated
  with check (user_id = auth.uid());

create policy deal_favorites_self_delete on public.deal_favorites
  for delete to authenticated
  using (user_id = auth.uid());

-- Grants: the default-privileges posture (set in 20260509000001) only grants
-- SELECT to `authenticated`, so DML must be granted explicitly per table —
-- same pattern as 20260519000003_app_user_authenticated_grants.sql. No UPDATE:
-- a favorite is a toggle (insert/delete), never edited in place.
grant select, insert, delete on public.deal_favorites to authenticated;
grant all privileges        on public.deal_favorites to service_role;
