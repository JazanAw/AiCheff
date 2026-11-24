-- Cheffity: Offer-History v1.
--
-- Hintergrund:
--   `public.deals` ist eine UPSERT-Tabelle. Beim nächsten Refresh
--   überschreibt der Backend-Sync vorherige Preise auf demselben
--   (source, source_external_id) — d.h. **Preisverläufe gehen verloren**,
--   und Angebote, die aus dem Snapshot herausfallen, hinterlassen nur den
--   letzten bekannten Stand mit altem `valid_to`.
--
-- Ziel dieser Migration:
--   Einen append-mostly Verlauf pro Snapshot anlegen, der ungenutzten
--   Live-Flow überhaupt nicht stört. `deals` bleibt unverändert. Bei jedem
--   Sync schreibt das Backend zusätzlich genau eine Zeile pro Offer in
--   `offer_history`, mit Snapshot-ID + first_seen/last_seen-Timestamps.
--
-- Nicht-Ziele:
--   - Kein Touch an `deals` / `deal_favorites` / Trends-Views.
--   - Keine Userdaten — die Tabelle ist Produkt-bezogen, nicht User-bezogen.
--   - Kein Backfill alter `deals`-Zeilen (würde gefälschte first_seen-Werte
--     erzeugen). History startet ab dem ersten Sync nach Deploy.

-- ─── offer_history ─────────────────────────────────────────────────────────
--
-- Eine Zeile = eine Beobachtung eines Angebots in einem Snapshot.
-- Append-mostly: pro snapshot_id + source + source_external_id darf es
-- höchstens eine Zeile geben (UNIQUE-Constraint). Innerhalb desselben
-- Snapshots schreibt das Backend daher idempotent.
--
-- Match-Strategie (cross-store, für "Wieder im Angebot" / Favoriten-Reuse):
--   - barcode (wenn bekannt) ist der harte Match-Schlüssel.
--   - canonical_product_key ist der weiche Fallback — generiert vom
--     Backend (`canonicalProductKey()` in `backend/src/offerHistory.ts`),
--     basiert auf normalisiertem Produktnamen.
--   - storage layer hier ist nur "store + lookup" — Matching-Logik bleibt
--     im Backend, damit wir sie ohne DB-Migration anpassen können.

create table public.offer_history (
  id                       uuid primary key default gen_random_uuid(),

  -- Snapshot bookkeeping. snapshot_id = ein Refresh/Sync-Lauf.
  snapshot_id              text not null,
  observed_at              timestamptz not null default now(),

  -- Source identity — spiegelt `deals.(source, source_external_id)` 1:1.
  -- Damit lässt sich History gegen die Live-Tabelle joinen, OHNE FK
  -- (deals-Zeilen können gelöscht werden, History soll überleben).
  source                   text not null,
  source_external_id       text not null,

  -- Produkt-Identität für cross-store Matching.
  canonical_product_key    text not null,
  barcode                  text,

  -- Denormalisierter Produkt-Snapshot. Genug, damit die History allein
  -- (ohne deals-Join) wieder gerendert werden kann — z. B. wenn das Live-
  -- Angebot bereits ausgelaufen + aus `deals` heraus rotiert ist.
  store_name               text not null,
  product_name             text not null,
  brand                    text,
  category                 text,
  image_url                text,

  -- Preis-Daten. Pflicht: current_price. Optional: original_price + savings.
  price                    numeric(10,2) not null check (price >= 0),
  original_price           numeric(10,2) check (original_price is null or original_price >= 0),
  savings_percent          numeric(5,2)  check (savings_percent is null or savings_percent between 0 and 100),
  currency                 char(3) not null default 'EUR',

  -- Gültigkeit aus dem Connector. Optional, weil OCR/Manual-Imports
  -- diese Felder nicht zuverlässig liefern.
  valid_from               date,
  valid_until              date,
  is_national              boolean,

  -- Lifecycle-Marker: first_seen wird beim allerersten Schreiben gesetzt,
  -- last_seen bei jedem nachfolgenden "still im Snapshot"-Sync aktualisiert.
  -- expired_at wird gesetzt, wenn ein Sync das Angebot NICHT mehr enthält
  -- (per Trigger / explicit Backend-Call, siehe TODOs).
  first_seen_at            timestamptz not null default now(),
  last_seen_at             timestamptz not null default now(),
  expired_at               timestamptz,

  -- Minimaler Raw-Payload für spätere Debugs. KEINE OCR-Volltexte und
  -- keine Connector-HTML-Dumps: nur ein kleines JSON mit dem, was wir
  -- aus Offer entnommen haben (siehe `buildHistoryRow` im Backend).
  raw_payload              jsonb,

  created_at               timestamptz not null default now(),

  constraint offer_history_snapshot_offer_unique
    unique (snapshot_id, source, source_external_id)
);

-- ─── Indexe ────────────────────────────────────────────────────────────────
-- Lookups:
--   1) Produkt-Suche cross-store: WHERE canonical_product_key = ? ORDER BY observed_at DESC
--   2) Pro Store-Marke: WHERE store_name = ? AND canonical_product_key = ?
--   3) Per Barcode: WHERE barcode = ?
--   4) Retention: DELETE WHERE observed_at < now() - interval '12 months'
--   5) "Wieder im Angebot": WHERE canonical_product_key = ? AND expired_at IS NULL
create index offer_history_canonical_idx
  on public.offer_history (canonical_product_key, observed_at desc);

create index offer_history_store_canonical_idx
  on public.offer_history (store_name, canonical_product_key);

create index offer_history_barcode_idx
  on public.offer_history (barcode)
  where barcode is not null;

create index offer_history_observed_idx
  on public.offer_history (observed_at desc);

create index offer_history_valid_until_idx
  on public.offer_history (valid_until);

create index offer_history_active_idx
  on public.offer_history (canonical_product_key, expired_at)
  where expired_at is null;

-- ─── RLS ───────────────────────────────────────────────────────────────────
-- Backend-only Schreibweg: der Service-Role-Key umgeht RLS sowieso, und
-- es gibt keinen User-Bezug → keine Public-Write-Policies. Lesen erlauben
-- wir Admins direkt; reguläre Authenticated-User sehen die Tabelle gar
-- nicht (nur Aggregations-Views könnten später anonymisierten Zugriff
-- bekommen).

alter table public.offer_history enable row level security;

create policy offer_history_admin_read on public.offer_history
  for select to authenticated
  using (public.is_admin());

-- Grants: nur Admin-Read über RLS, alle Writes ausschließlich via
-- service_role aus dem Backend. Default-Privileges (siehe
-- 20260509000001_grant_service_role.sql) geben service_role bereits ALL,
-- expliziter Grant für Klarheit.
grant select on public.offer_history to authenticated;
grant all privileges on public.offer_history to service_role;

-- ─── Hilfs-View für Admin-Reports ──────────────────────────────────────────
-- Aktuell aktive (= noch nicht expired_at) Beobachtungen pro
-- canonical_product_key + store_name, sortiert nach letztem Sehen.
-- Genau die Form, die `/api/admin/history` für die "Top-Produkte mit
-- mehreren Preisbeobachtungen" und "wieder im Angebot"-Karten braucht.
create view public.offer_history_recent as
  select
    canonical_product_key,
    store_name,
    max(product_name)        as sample_name,
    max(brand)               as sample_brand,
    count(*)::int            as observation_count,
    min(price)               as min_price,
    max(price)               as max_price,
    min(observed_at)         as first_observed,
    max(observed_at)         as last_observed,
    bool_or(expired_at is null) as has_active
  from public.offer_history
  group by canonical_product_key, store_name;

-- View security note (decided 2026-05-28):
--   The view runs with the owner's (postgres) rights and would therefore
--   bypass the `offer_history_admin_read` RLS policy if granted to plain
--   authenticated users — every signed-in user could read the aggregate.
--   The endpoint that consumes this view (`/api/admin/history`) goes through
--   the service-role key from the backend, so authenticated never needs
--   direct SELECT. We grant service_role only.
grant select on public.offer_history_recent to service_role;
