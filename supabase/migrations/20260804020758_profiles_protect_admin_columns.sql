-- Cheffity: schützt Moderations- und Identitätsspalten in public.profiles
-- gegen Selbstbedienung durch normale App-Nutzer.
--
-- BEFUND
-- ------
-- `20260507000002_users.sql` erlaubt Nutzern das Update ihrer eigenen Zeile:
--
--     create policy profiles_self_update on public.profiles
--       for update to authenticated
--       using (id = auth.uid()) with check (id = auth.uid());
--
-- Die Policy prüft ausschließlich, WELCHE Zeile geschrieben wird — nicht,
-- WELCHE SPALTEN. `20260519000003_app_user_authenticated_grants.sql` erteilt
-- dazu ein tabellenweites `grant select, update on public.profiles`. In
-- Kombination kann jeder eingeloggte Nutzer per Supabase-REST auf der
-- eigenen Zeile beliebige Spalten setzen, u. a.:
--
--     PATCH /rest/v1/profiles?id=eq.<eigene-uid>
--     { "banned": false, "banned_reason": null, "banned_at": null }
--
-- Damit hebt ein gesperrter Nutzer seine eigene Sperre auf. Ebenso lässt
-- sich `email` verändern, die dadurch von `auth.users.email` abweicht —
-- relevant, weil `recipe_comments.author_name` aus der E-Mail befüllt wurde
-- (siehe 20260509000002) und `profiles.email` als Identitätsanker dient.
--
-- WARUM TRIGGER UND NICHT SPALTEN-GRANT
-- -------------------------------------
-- Naheliegend wäre `revoke update ... ; grant update (spalte, ...)`. Das
-- scheitert hier: Admins arbeiten laut `profiles_admin_update` ebenfalls in
-- der Rolle `authenticated`. Ein Spalten-Revoke auf `banned` würde ihnen das
-- Bannen mit entziehen — Spaltenrechte kennen kein `is_admin()`. Der Trigger
-- kann zwischen Nutzer, Admin und service_role unterscheiden.
--
-- VERHALTEN
-- ---------
-- Nicht-Admins schreiben geschützte Spalten still auf den ALTEN Wert zurück,
-- statt einen Fehler zu werfen. Bewusst gewählt: Clients, die eine komplette
-- Profilzeile zurück-PATCHen (unverändertes `banned` inklusive), funktionieren
-- weiter, während echte Änderungsversuche wirkungslos bleiben. Ein Angreifer
-- bekommt 200 OK, aber keine Wirkung — das verrät auch nichts über die
-- Existenz der Schutzregel.
--
-- Nicht betroffen: display_name, avatar_url, language, country_code,
-- onboarding_completed, last_active_at. Die bleiben nutzerseitig schreibbar
-- (die Mobile-App schreibt heute ausschließlich onboarding_completed).

-- WICHTIG: bewusst SECURITY INVOKER (= Default, kein `security definer`).
-- In einer SECURITY-DEFINER-Funktion liefert `current_user` den Eigentümer
-- der Funktion (postgres), nicht den Aufrufer — die Rollenprüfung unten
-- würde dann immer greifen und der Schutz wäre wirkungslos. Als INVOKER ist
-- `current_user` die tatsächlich ausführende Rolle: `authenticated` für
-- App-Nutzer, `service_role` fürs Backend, `postgres` für Migrationen.
-- `public.is_admin()` ist selbst SECURITY DEFINER und an `authenticated`
-- granted, funktioniert hier also unverändert.
create or replace function public.profiles_guard_protected_columns()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- service_role, postgres, Migrationen, Supabase Studio: unverändert
  -- durchlassen. Diese Pfade sind bereits privilegiert; der Trigger soll
  -- nur den JWT-Pfad der App einschränken.
  if current_user <> 'authenticated' then
    return new;
  end if;

  -- Admins dürfen moderieren (deckt sich mit profiles_admin_update).
  if public.is_admin() then
    return new;
  end if;

  -- Ab hier: normaler App-Nutzer auf der eigenen Zeile.
  new.banned        := old.banned;
  new.banned_reason := old.banned_reason;
  new.banned_at     := old.banned_at;

  -- Identitätsanker: spiegelt auth.users und wird nicht vom Client gesetzt.
  new.email         := old.email;

  -- Anlagezeitpunkt ist unveränderlich.
  new.created_at    := old.created_at;

  return new;
end;
$$;

comment on function public.profiles_guard_protected_columns() is
  'Setzt banned/banned_reason/banned_at/email/created_at auf den Altwert '
  'zurueck, wenn ein normaler App-Nutzer (Rolle authenticated, kein Admin) '
  'sie zu aendern versucht. Verhindert Selbst-Entbannung ueber die REST-API.';

-- Name mit `zz_`-Praefix: gleichzeitig laufende BEFORE-UPDATE-Trigger
-- feuern in alphabetischer Reihenfolge. So greift der Schutz zuletzt und
-- kann von `profiles_set_updated_at` nicht überschrieben werden.
drop trigger if exists zz_profiles_guard_protected_columns on public.profiles;

create trigger zz_profiles_guard_protected_columns
  before update on public.profiles
  for each row execute function public.profiles_guard_protected_columns();

-- STAND / VERIFIKATION
-- --------------------
-- Angewendet auf das Remote-Projekt am 2026-08-04.
-- Der Dateiname traegt die Version, die Supabase beim Apply vergeben hat
-- (20260804020758), damit lokal und remote deckungsgleich bleiben.
--
-- Vorbefund auf der Produktivdatenbank, vor dem Apply gemessen:
--   guard_trigger vorhanden : 0
--   UPDATE-Spalten-Grants fuer `authenticated` auf profiles : 13 von 13
--   profiles_self_update Policy : vorhanden, ohne Spaltenpruefung
-- Die Luecke war also real, nicht nur theoretisch.
--
-- Nach dem Apply verifiziert:
--   Trigger zz_profiles_guard_protected_columns : aktiv, BEFORE, ROW
--   prosecdef der Funktion : false  -> INVOKER, wie beabsichtigt
--   Trigger-Reihenfolge : nach profiles_set_updated_at (alphabetisch)
--   Legitimer Write als authenticated : display_name NULL -> 'GUARD-TEST'
--     ging durch, banned und email blieben unveraendert. Test lief in einem
--     DO-Block mit `raise exception` und wurde vollstaendig zurueckgerollt.
--
-- NOCH OFFEN: Der Negativtest (Nicht-Admin versucht Selbst-Entbannung, muss
-- wirkungslos bleiben) konnte nicht ausgefuehrt werden — es existiert erst
-- ein einziges Profil, und das ist der Admin-Account. Sobald der erste
-- normale Nutzer angelegt ist, einmal nachholen:
--
--   -- <uid> = ein Profil, das NICHT in public.admins steht
--   update public.profiles set banned = true, banned_reason = 'test'
--    where id = '<uid>';
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<uid>","role":"authenticated"}';
--   update public.profiles set banned = false where id = '<uid>';
--   reset role;
--   -- ERWARTET: weiterhin true. Das UPDATE laeuft ohne Fehler durch,
--   -- der Trigger setzt still auf den Altwert zurueck.
--   select banned, banned_reason from public.profiles where id = '<uid>';
--
-- Der Admin-Pfad laeuft ohnehin ueber die SECURITY-DEFINER-RPC
-- public.admin_set_user_banned(). Darin ist `current_user` der Owner
-- (postgres), nicht `authenticated` — der Guard laesst sie also passieren.
