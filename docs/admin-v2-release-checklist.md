# Admin v2 — Release Checklist

Stand: 2026-05-27

> Diese Datei sammelt alles, was geprüft, gesetzt oder umgebaut werden muss,
> bevor wir die alte `/`-Route auf das neue `/admin-v2`-Dashboard
> umschalten. Wird laufend aktualisiert.

## 1. Aktueller Stand

- `/` → altes Dashboard (`renderDashboardHtml`) — **unverändert, bleibt aktiv**.
- `/admin-v2` → neues Control Center (`renderAdminDashboardHtml`) — läuft
  parallel, kein Switch.
- Rollback ist trivial: kein Switch passiert ohne expliziten Edit der
  beiden Routen in `backend/src/server.ts`.

## 2. Funktionen — was getestet sein muss

### 2.1 Übersicht
- [ ] KPIs zeigen echte Zahlen (live/filtered/next/stores/users/abos).
- [ ] Warnungen erscheinen nur bei echten Problemen
      (Low-Store, niedrige Coverage, Ollama offline, Client-Errors).
- [ ] Quick-Actions führen aus: One-Click-KI, Mobile starten, Supabase
      Sync, Logs öffnen.
- [ ] Activity-Feed zeigt jüngste Debug-Log-Events.

### 2.2 Angebote
- [ ] Tabs Live/Filtered/Next Week funktionieren.
- [ ] Such- und Store-Filter wirken in der gerenderten Tabelle.
- [ ] Buttons: Neu laden, Food Filter, KI Scan, Supabase Sync, Export
      JSON, Export CSV, Auswahl → Filtered.
- [ ] N/H/A-Status-Icons sind aus echten Felder berechnet
      (`nutrition`, `isHalal`, `allergens`).

### 2.3 Datenqualität
- [ ] KPI-Bar zeigt echte Coverage-Prozente.
- [ ] Store-Tabelle sortiert nach Kritikalität.
- [ ] Review-Liste filtert nach Reason.
- [ ] JSON-Download liefert vollen Report.

### 2.4 Trends
- [ ] Banner „Supabase nicht konfiguriert" erscheint, wenn Service-Role
      fehlt.
- [ ] Mit konfiguriertem Supabase: Top-Listen aus
      `product_trend_30d` / `recipe_trend_30d` füllen sich.
- [ ] Falls Listen leer → einzelne „Noch keine Trenddaten" Empty States
      bleiben sichtbar (nicht crashen).

### 2.5 Nutzer & Abos
- [ ] KPIs aus `subscriber_counts` + `profiles`-Aggregate.
- [ ] Plan-Verteilung als Balken (Free/Plus/Premium).
- [ ] Stripe-Health zeigt `customersWithSubscription`, Events 7d, letztes
      Event.
- [ ] **NEU:** `/api/admin/users/events` lädt aggregierte Events ohne PII
      (Stripe + Subscriptions + Profiles).
- [ ] Bei Supabase-offline → klarer Banner, keine Fake-Zahlen.

### 2.6 KI & Jobs
- [ ] Ollama-Detail (Status, PID, Start, letzter Fehler).
- [ ] Pull-/Job-Status-Liste (in-memory).
- [ ] **NEU:** Installierte Modelle aus `/api/admin/ollama/models`
      (Timeout 2.5 s, sauberer Empty-State bei offline).
- [ ] Job-History (in-memory) + **NEU:** Disk-Runs aus
      `backend/data/categorizer-runs/` als historische Marker.
- [ ] Buttons: Modell laden, Ollama Start/Stop, KI Scan, One-Click-KI.

### 2.7 Imports & Quellen
- [ ] Tabelle pro Connector × Store mit Coverage + Warnings.
- [ ] REWE Screenshot/PDF-Import öffnet `/rewe-screenshot-import`.
- [ ] Quellen-Warnungen-Panel zeigt nur echte Probleme.

### 2.8 System & Logs
- [ ] Service-Grid (Backend/Mobile/Ollama/Vite/Supabase/Categorizer).
- [ ] Mobile-QR + Start/Stop/Refresh.
- [ ] Client-Errors aus Debug-Log gefiltert.
- [ ] Log-Konsole mit Level-Filter (all/error/warn/info).
- [ ] Logs leeren + Refresh.

### 2.9 Spec / Übergabe
- [ ] Komponenten-Spec sichtbar.
- [ ] Endpunkt-Mapping (echt vs. geplant) aktuell.
- [ ] Bekannte Lücken benannt.

## 3. ENV Vars vor Switch

| Variable | Pflicht? | Wofür |
|---|---|---|
| `PORT` | optional | Default `8787` |
| `APP_URL` | optional | Frontend-URL für "Altes Dashboard"-Link |
| `SUPABASE_URL` | für Abos/Trends/Events | Sonst Banner „nicht konfiguriert" |
| `SUPABASE_SERVICE_ROLE_KEY` | für Abos/Trends/Events | **niemals committen** |
| `VITE_OLLAMA_HOST` | optional | Default `http://localhost:11434` |
| `VITE_OLLAMA_MODEL` | optional | Default `qwen2.5:14b-instruct` |
| `BACKEND_CONSOLE_LOG_LEVEL` | optional | `debug|info|warn|error` |

Alle Endpunkte degradieren sauber, wenn die Variable fehlt — kein Crash.

## 4. Remote-Schutz (Pflicht vor öffentlichem Deploy)

`/admin-v2` und alle `/api/admin/*`-Endpunkte sind aktuell **ohne Auth**.
Das ist okay solange das Backend nur auf `127.0.0.1:8787` lauscht. Sobald
das Backend remote erreichbar wird, MUSS einer der folgenden
Mechanismen aktiviert sein:

1. **Kurzfristig (lowest effort, höchste Sicherheit):**
   - Reverse-Proxy (nginx/Caddy) mit Basic-Auth vor das Backend setzen.
   - Oder das Backend NUR über VPN/WireGuard erreichbar machen.
   - Kein Code-Change nötig.

2. **Mittelfristig (in-process):**
   - Express-Middleware, die `Authorization: Bearer <jwt>` verifiziert
     gegen Supabase Auth (`supabase.auth.getUser(jwt)`).
   - User → `public.is_admin()` RPC aufrufen → wenn `false`, 403.
   - Hooks die Middleware nur an `/api/admin/*` + `/admin-v2`, nicht an
     die operativen `/api/offers/*`-Endpunkte (die sind weiter öffentlich
     wie das alte Dashboard erwartet).

3. **Langfristig:**
   - Das separate `admin/`-Projekt (Vite + Tailwind + Supabase-Auth)
     übernimmt die User-facing-Admin-Rolle.
   - `/admin-v2` bleibt als lokales Ops-Tool und ist im prod nicht mehr
     exposed.

**Empfehlung:** Bis Phase 3 kommt, Phase 1 (Reverse-Proxy / VPN-only)
fahren. Phase 2 bewusst NICHT implementiert — verkauft sonst falsche
Sicherheit, wenn jemand die Middleware übersieht.

## 5. Datenquellen — was wirklich verbunden ist

| Endpunkt | Quelle | Status |
|---|---|---|
| `/api/admin/overview` | Snapshot + Supabase subs/profiles + Ingest/AI-States | echt |
| `/api/admin/subscriptions` | `public.profiles`, `public.subscriptions`, `public.stripe_events` | echt (braucht Service-Role) |
| `/api/admin/trends` | `product_trend_30d`, `recipe_trend_30d`, `shopping_list_items` | echt (braucht Service-Role) |
| `/api/admin/sources` | In-Memory Snapshot der Offers | echt |
| `/api/admin/jobs` | In-Memory Process-States | echt |
| **`/api/admin/jobs/history`** ✱ | In-Memory + `backend/data/categorizer-runs/*` Disk-Scan | echt |
| **`/api/admin/ollama/models`** ✱ | `${OLLAMA_HOST}/api/tags` | echt (2.5s Timeout) |
| **`/api/admin/users/events`** ✱ | `stripe_events`, `subscriptions`, `profiles` (alle PII-frei) | echt (braucht Service-Role) |

✱ neu in dieser Iteration.

### Persistente Job-History (geplante Migration)

Aktuelle Job-History ist in-memory + Disk-Scan der categorizer-runs. Für
echte Persistenz vorgeschlagen:

```sql
-- supabase/migrations/2026XXXXX000XXX_admin_job_runs.sql (NICHT GEPUSHT)
create table public.admin_job_runs (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in (
    'ingest', 'one_click_ai', 'ai_rescan', 'ollama_pull',
    'supabase_sync', 'categorizer'
  )),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null check (status in (
    'running', 'done', 'error', 'idle'
  )),
  message      text,
  error_text   text,
  metrics      jsonb,
  created_at   timestamptz not null default now()
);
create index admin_job_runs_kind_started_idx
  on public.admin_job_runs (kind, started_at desc);
alter table public.admin_job_runs enable row level security;
create policy admin_job_runs_admin_only on public.admin_job_runs
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());
```

**Nicht angelegt** — wartet auf OK + Auth-Story (Punkt 4). Bis dahin
reicht der In-Memory + Disk-Scan-Pfad.

## 6. Daten-Lücken (nicht blockierend, aber dokumentiert)

- `recipe_cooked_log` ist meist leer — Mobile triggert noch keinen
  Cooked-Event. Top-Cooked-Rezepte bleiben daher meist leer.
- `shopping_list_items.purchased_at` wird nicht durchgängig gesetzt.
  Top-Purchased-Produkte bleiben evtl. leer.
- `product_trend_30d`-View hat eine Schwelle `count(*) >= 2`. Bei
  geringer User-Aktivität sind die Top-Listen entsprechend kurz.
- `aichef_offers`-Pipeline (Nutrition/Halal/Allergene) läuft nur via
  One-Click-KI — Coverage bleibt sonst niedrig.

## 7. Rollback-Plan

`/` zeigt weiter `renderDashboardHtml(frontendUrl)` (das alte Dashboard).
Wenn `/admin-v2` produktiv geschaltet wird:

1. Edit in `backend/src/server.ts`: `/` → `renderAdminDashboardHtml`.
2. Backend neu starten.
3. Bei Problemen: Edit rückgängig machen + Restart → altes Dashboard ist
   sofort wieder unter `/` da. Beide Module bleiben im Source vorhanden.

**Empfohlen:** alte `renderDashboardHtml`-Funktion + `dashboardHtml.ts`
**nicht löschen**, bis `/admin-v2` mindestens 4 Wochen ohne Beschwerde
produktiv läuft.

## 8. Vor dem Switch erledigen

- [ ] Auth-Story aus Punkt 4 entscheiden + umsetzen, falls Remote-Zugriff.
- [ ] Mindestens 1 Stunde mit konfiguriertem Supabase-Service-Role alle 8
      Bereiche durchklicken — keine Crashes, keine Fake-Zahlen, alle
      Buttons reagieren.
- [ ] Mobile QR-Display live verifizieren (sobald Mobile gestartet ist).
- [ ] Job-History-Disk-Scan auf eigener Maschine prüfen (~25 Runs ok,
      kein Throttling).
- [ ] Ollama-Models-Endpoint mit gestopptem Ollama testen → muss in < 3 s
      antworten mit `available: false`.

## 9. Nach dem Switch

- [ ] `/` zeigt neues Dashboard.
- [ ] Altes `dashboardHtml.ts` bleibt als Kommentar verlinkt im Code.
- [ ] Nach 4 Wochen ohne Probleme: alte Datei löschen + `/legacy`-Alias
      entfernen (falls eingerichtet).
