-- Korrektur zu 20260817000001: Favoriten ankern auf `article_id`, nicht auf
-- `product_key`.
--
-- Die Vorgängermigration hat `product_key` (productKeyForOffer: Name+Marke+
-- GRÖSSE) als Anker eingeführt. Das war der zweitbeste Schlüssel — das Projekt
-- hat mit `articleId` (src/utils/articleIdentity.ts, `article_v3`) längst eine
-- eigens für Favoriten gebaute Produktfamilien-Identität, die Kette, Preis,
-- Gültigkeit, Packungsgröße UND Sortenbezeichner ignoriert.
--
-- Gemessen am 2026-08-17 über zwei echte Läufe (873 gemeinsame Produkte,
-- 27.05. -> 01.06.):
--     offer.id     98,4 % wochenstabil
--     product_key  97,5 %
--     article_id   99,3 %   <- bester Anker
-- Bei allen drei Lidl-Cross-Wochen-Produkten (wo die Angebots-ID wechselt)
-- liefert article_id EINEN Wert. Zusätzlich findet er im Live-Feed dieselbe
-- Produktfamilie über 38 Ketten-Paare hinweg — Favoriten können damit auch
-- "gleiches Produkt, anderer Laden" auflösen, was product_key nicht kann.
--
-- `product_key` wird wieder entfernt: Die Spalte ist erst Minuten alt, trägt in
-- keiner Zeile Daten und wird von keinem ausgelieferten Code gelesen. Zwei
-- konkurrierende Anker nebeneinander stehen zu lassen wäre die schlechtere
-- Hinterlassenschaft als diese eine korrigierende Migration.
--
-- `article_id` ist nullable und additiv: `deal_id` bleibt Bestandteil des
-- Primärschlüssels von deal_favorites, bestehende Zeilen bleiben gültig, und
-- die Insert/Delete-Semantik der Favoriten ändert sich nicht. Kein Backfill der
-- Alt-Deals — der nächste Wochenscan upsertet jeden aktuellen Deal und füllt
-- die Spalte aus der einen gültigen TypeScript-Quelle.

drop index if exists public.deals_product_key_idx;

alter table public.deals    drop column if exists product_key;
alter table public.deal_favorites drop column if exists product_key;

alter table public.deals
  add column if not exists article_id text;

comment on column public.deals.article_id is
  'Produktfamilien-Identitaet (articleIdForOffer, article_v3): ignoriert Kette, Preis, Gueltigkeit, Packungsgroesse und Sortenbezeichner. Wochenstabiler Anker fuer Favoriten und Preisvergleich ueber Ketten hinweg.';

-- Partiell: bis der erste Scan gelaufen ist, ist die Spalte ueberwiegend NULL.
create index if not exists deals_article_id_idx
  on public.deals (article_id)
  where article_id is not null;

alter table public.deal_favorites
  add column if not exists article_id text;

comment on column public.deal_favorites.article_id is
  'Produktfamilien-Anker des Favoriten. Loest einen Favoriten nach dem Wochenwechsel wieder auf ein aktuell gueltiges Angebot auf, auch wenn die deal_id (und damit das konkrete Haendler-Angebot) nicht mehr existiert.';

-- Bewusst KEIN Index auf deal_favorites.article_id: Die Leserichtung ist
-- "meine Favoriten" (deckt deal_favorites_user_idx ab) und von dort per
-- article_id nach public.deals (deckt deals_article_id_idx ab).

-- Grants/RLS unveraendert: Die Policies auf deal_favorites sind
-- spaltenunabhaengig (user_id = auth.uid()).
