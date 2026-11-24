-- Drei neue Deal-Kategorien: bakery, pantry, ready_meals.
--
-- PROBLEM: Das Enum kannte nur sieben Werte und keinen davon fuer Backwaren,
-- Grundnahrungsmittel/Saucen oder Fertiggerichte. Alles davon fiel in 'other'.
-- Gemessen am Live-Feed vom 2026-08-17 lagen dort 214 von 1287 Angeboten (17 %),
-- und 211 davon waren saubere Lebensmittelgruppen, keine Restposten:
--     Gewuerze/Saucen/Aufstriche   57
--     Konserven & Fertiggerichte   56
--     Grundnahrungsmittel          50
--     Backwaren                    34
--     Feinkost & Kuehlung          14
-- Die Backend-Pipeline trennt diese Gruppen laengst sauber — nur das
-- Ausgabe-Schema hatte keinen Platz dafuer, weshalb Brot in der App neben
-- Suessigkeiten landete.
--
-- ZUORDNUNG (siehe mobile/src/services/dealCategory.ts, identisch im
-- Backend-Sync):
--     bakery       <- Backwaren
--     pantry       <- Grundnahrungsmittel, Gewuerze/Saucen/Aufstriche
--     ready_meals  <- Konserven & Fertiggerichte, Feinkost & Kuehlung
--
-- Rein additiv: bestehende Zeilen behalten ihren Wert, 'other' bleibt als
-- Auffangwert und Default bestehen. Bereits gespeicherte Deals werden NICHT
-- umgeschrieben — der naechste Wochenscan upsertet sie ohnehin und vergibt die
-- neuen Werte aus der einen gueltigen Zuordnung.
--
-- Hinweis fuer spaetere Migrationen: Ein per ALTER TYPE ergaenzter Enum-Wert
-- darf in DERSELBEN Transaktion noch nicht verwendet werden. Deshalb steht hier
-- ausschliesslich das ADD VALUE, kein Datenupdate.

alter type public.deal_category add value if not exists 'bakery';
alter type public.deal_category add value if not exists 'pantry';
alter type public.deal_category add value if not exists 'ready_meals';
