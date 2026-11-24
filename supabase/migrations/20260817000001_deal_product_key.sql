-- Wochenstabiler Produkt-Anker für Deals und Favoriten.
--
-- PROBLEM: `deals.source_external_id` ist `<store>::<offer.id>`, und `offer.id`
-- (stableOfficialId) hasht die `sourceUrl` mit. Lidl und ALDI NORD legen pro
-- Aktionswoche eine NEUE Produktseite für dieselbe Ware an, deshalb wechselt die
-- ID wöchentlich. Gemessen am 2026-08-17 über zwei echte Läufe (873 gemeinsame
-- Produkte): Kaufland/HIT/EDEKA 100 % stabil, ALDI SÜD 99 %, NORMA 96 % — aber
-- ALDI NORD nur 14 %, und bei Lidl behielt KEINES der drei Cross-Wochen-Produkte
-- seine ID (`crivit damen funktionsshirt`, gleicher Preis 3,99 €:
-- official_rwu3cb -> official_sinqne).
--
-- Folge für `deal_favorites`: Die Tabelle ankert auf genau dieser `deal_id`. Ein
-- Favorit zeigt nach dem Wochenwechsel ins Leere und kann nur noch den
-- eingefrorenen Snapshot (deal_name/store_name/current_price) rendern, statt auf
-- das aktuell gültige Angebot desselben Produkts aufzulösen.
--
-- LÖSUNG: `product_key` als zusätzlichen Anker mitführen — Barcode, sonst
-- Name+Marke+Größe, bewusst OHNE Kette/Preis/Gültigkeit (siehe
-- `productKeyForOffer` in backend/src/offerProductIntelligence.ts). Für alle drei
-- Lidl-Fälle liefert er EINEN Key, wo die ID zwei vergibt.
--
-- Additiv und nullable: `deal_id` bleibt Bestandteil des Primärschlüssels, die
-- bestehende Insert/Delete-Semantik der Favoriten bleibt unverändert, und alle
-- vorhandenen Zeilen bleiben gültig.
--
-- KEIN Backfill der 12.248 Alt-Deals: Die Normalisierung (Umlaut-Transliteration
-- ä->ae etc.) in SQL nachzubauen würde von der TypeScript-Implementierung
-- abdriften — genau die Doppelimplementierung, die das Projekt anderswo per
-- Drift-Guard verhindert. Der nächste Wochenscan upsertet ohnehin jeden
-- aktuellen Deal und füllt die Spalte mit der einen gültigen Quelle.

alter table public.deals
  add column if not exists product_key text;

comment on column public.deals.product_key is
  'Wochenstabile Produkt-Identitaet (productKeyForOffer): Barcode, sonst Name+Marke+Groesse. Ohne Kette/Preis/Gueltigkeit, damit dieselbe Ware ueber Aktionswochen hinweg denselben Wert behaelt.';

-- Partiell: nur nicht-leere Keys sind nachschlagbar, und bis der erste Scan
-- gelaufen ist, ist die Spalte ueberwiegend NULL.
create index if not exists deals_product_key_idx
  on public.deals (product_key)
  where product_key is not null;

alter table public.deal_favorites
  add column if not exists product_key text;

comment on column public.deal_favorites.product_key is
  'Produkt-Anker des Favoriten. Erlaubt, einen Favoriten nach dem Wochenwechsel wieder auf ein aktuell gueltiges Angebot aufzuloesen, wenn die deal_id nicht mehr existiert.';

-- Bewusst KEIN Index auf deal_favorites.product_key: Die Leserichtung ist
-- "meine Favoriten" (deckt deal_favorites_user_idx ab) und von dort per
-- product_key nach public.deals (deckt deals_product_key_idx ab). Ein Index auf
-- der Favoritenseite haette derzeit kein Abfragemuster.

-- Grants/RLS bleiben unveraendert: Die Policies auf deal_favorites sind
-- spaltenunabhaengig (user_id = auth.uid()), eine zusaetzliche Spalte aendert
-- daran nichts.
