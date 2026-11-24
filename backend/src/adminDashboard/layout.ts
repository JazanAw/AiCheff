// HTML body for /admin-v2 — ported 1:1 from Claude Design "Control Center.html".
// Sidebar with 3 grouped sections (Operations / System / Übergabe), breadcrumb
// topbar with global search + theme toggle, 9 screen panels in the DOM.
// Screen visibility toggled by JS via `.active`.

export function adminDashboardLayout(): string {
  return `
    <div class="app">

      <!-- Sidebar -->
      <aside class="sidebar">
        <div class="sidebar-head">
          <div class="sidebar-mark">C</div>
          <div>
            <div class="sidebar-title">Cheffity</div>
            <div class="sidebar-sub">Control Center</div>
          </div>
        </div>

        <div class="nav-cat">Operations</div>
        <nav class="nav-group" id="nav-ops"></nav>

        <div class="nav-cat">System</div>
        <nav class="nav-group" id="nav-sys"></nav>

        <div class="nav-cat">Übergabe</div>
        <nav class="nav-group" id="nav-handoff"></nav>

        <div class="sidebar-foot">
          <div class="env-line"><span class="dot"></span><span><strong>local</strong> · :8787</span></div>
          <div class="env-line" style="padding-top:0"><span id="env-build">/admin-v2 · dev</span></div>
        </div>
      </aside>

      <!-- Main shell -->
      <main class="shell">
        <header class="topbar">
          <nav class="breadcrumb">
            <span>Backend</span>
            <span class="sep">/</span>
            <strong id="crumb">Übersicht</strong>
          </nav>
          <span class="spacer"></span>
          <label class="global-search">
            <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.65" y2="16.65"/></svg>
            <input id="global-search" placeholder="Suchen: Angebot, Quelle, Job, Log…" />
            <span class="kbd">⌘ K</span>
          </label>
          <button class="icon-btn" data-action="legacy-open" title="Altes Dashboard">
            <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            <span>Legacy</span>
          </button>
          <button class="icon-btn" id="theme-toggle-btn" data-action="theme-toggle">
            <svg class="ico" id="theme-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></svg>
            <span id="theme-label">Dark</span>
          </button>
          <button class="icon-btn" data-action="refresh-all" title="Alles neu laden">
            <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          </button>
          <button class="icon-btn" data-action="backend-restart" title="Backend neu starten" aria-label="Backend neu starten">
            <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
          </button>
          <button class="icon-btn" data-action="backend-off" title="Backend beenden" aria-label="Backend beenden" style="color:var(--danger)">
            <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="12"/><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/></svg>
          </button>
        </header>
        <div id="status-bar" class="status-bar" data-kind="info">Lade Daten…</div>

        <div id="screens">

          <!-- 1 · Übersicht -->
          <div class="screen" data-screen="overview">
            <div class="page">
              <div class="page-head">
                <div>
                  <h1>Übersicht</h1>
                  <div class="page-sub" id="overview-meta">Snapshot wird geladen…</div>
                </div>
                <span class="spacer"></span>
                <div class="actions">
                  <button class="btn" data-action="refresh-all"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>Aktualisieren</button>
                  <button class="btn" data-action="one-click-ai" title="Bisheriger Vollscan: Scrape · Filter · KI · Nährwerte/Halal für ALLE Angebote in einem Durchlauf (kann lange dauern)."><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>Angebots-Scan 1.0</button>
                  <!-- Angebots-Scan 2.0 — Split-Button: Hauptaktion startet Phase 1 + 2,
                       Dropdown-Pfeil wählt einzelne Phasen. -->
                  <div class="split-btn" id="scan-v2-split">
                    <button class="btn primary" id="scan-v2-btn" data-action="scan-v2-start" data-mode="phase1_phase2" title="Neuer zweiphasiger Scan: Phase 1 Schnellscan (Angebote sichtbar) + Phase 2 Food-Analyse (Nährwerte/Halal nur für Lebensmittel)."><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>Angebots-Scan 2.0</button>
                    <button class="btn primary split-toggle" id="scan-v2-toggle" data-action="scan-v2-menu-toggle" title="Einzelne Phasen wählen" aria-haspopup="true" aria-expanded="false"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
                    <div class="split-menu" id="scan-v2-menu" hidden>
                      <button class="split-menu-item" data-action="scan-v2-start" data-mode="phase1">Phase 1: Schnellscan</button>
                      <button class="split-menu-item" data-action="scan-v2-start" data-mode="phase2">Phase 2: Food-Analyse</button>
                      <button class="split-menu-item" data-action="scan-v2-start" data-mode="phase1_phase2">Phase 1 + 2 komplett</button>
                    </div>
                  </div>
                  <button class="btn" id="scan-v2-pause-btn" data-action="scan-v2-pause" title="Pausiert den laufenden Angebots-Scan 2.0 und sichert den Fortschritt (Checkpoint). Resume setzt genau dort fort." style="display:none"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>Pause</button>
                  <button class="btn primary" id="scan-v2-resume-btn" data-action="scan-v2-resume" title="Setzt einen pausierten Angebots-Scan 2.0 aus dem gespeicherten Checkpoint fort (auch nach Backend-Neustart)." style="display:none"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>Fortsetzen</button>
                  <button class="btn danger" id="scan-v2-cancel-btn" data-action="scan-v2-cancel" title="Bricht den laufenden oder pausierten Angebots-Scan 2.0 ab (verwirft den Checkpoint; Phase-1-Daten im Snapshot bleiben erhalten)." style="display:none"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>Abbrechen</button>
                </div>
              </div>

              <section class="section">
                <div class="kpi-bar" id="overview-kpi"></div>
              </section>

              <section class="section" id="scan-v2-section" style="display:none">
                <div class="panel">
                  <div class="panel-head">
                    <h3>Angebots-Scan 2.0</h3>
                    <span class="panel-meta" id="scan-v2-phase-badge">idle</span>
                  </div>
                  <div id="scan-v2-status" class="page-sub">Noch kein Angebots-Scan 2.0 gelaufen.</div>
                  <div id="scan-v2-stats" style="margin-top:8px;display:flex;flex-wrap:wrap;gap:8px"></div>
                  <div style="margin-top:8px;font-size:11.5px;color:var(--muted)">
                    <strong>Phase 1 (Schnellscan):</strong> sammelt Angebote, prüft Bilder auf Broken-Links, schiebt sicheres Non-Food raus.
                    <strong>Phase 2 (Food-Analyse):</strong> Nährwerte/Allergene/Halal nur für echte Lebensmittel.
                  </div>
                </div>
              </section>

              <section class="section">
                <div class="section-body">
                  <div class="panel">
                    <div class="panel-head">
                      <h3>Achtung</h3>
                      <span class="panel-meta" id="attn-count">–</span>
                    </div>
                    <div class="attn-list" id="attn-list"></div>
                  </div>
                  <div class="panel">
                    <div class="panel-head">
                      <h3>Schnellaktionen</h3>
                      <span class="panel-meta">operativ</span>
                    </div>
                    <div class="qa-grid" id="qa-grid"></div>
                  </div>
                </div>
              </section>

              <section class="section">
                <div class="section-head">
                  <h2>Letzte Aktivität</h2>
                  <span class="meta">letzte 200 Log-Events</span>
                  <span class="spacer"></span>
                  <div class="actions"><button class="btn ghost" data-action="goto-system">Alle Logs</button></div>
                </div>
                <div class="panel" style="padding-top: 6px">
                  <div class="feed" id="overview-feed"></div>
                </div>
              </section>
            </div>
          </div>

          <!-- 2 · Angebote -->
          <div class="screen" data-screen="offers">
            <div class="page">
              <div class="page-head">
                <div>
                  <h1>Angebote</h1>
                  <div class="page-sub" id="offers-meta">–</div>
                </div>
                <span class="spacer"></span>
                <div class="actions">
                  <button class="btn" data-action="refresh-offers">Neu laden</button>
                  <button class="btn" data-action="filter-food">Food Filter</button>
                  <button class="btn" data-action="ai-rescan">KI Scan</button>
                  <button class="btn" data-action="supabase-sync">Supabase Sync</button>
                  <button class="btn" data-action="export-live-json">Export JSON</button>
                  <button class="btn" data-action="export-live-csv">Export CSV</button>
                  <button class="btn" data-action="export-snapshot-file" title="backend/data/offers.json herunterladen — fuer einen zweiten Rechner">Snapshot-Datei</button>
                  <button class="btn danger" data-action="offers-selected-to-filtered">Auswahl verschieben</button>
                </div>
              </div>

              <section class="section">
                <div class="section-head">
                  <div class="seg" id="offers-tabs">
                    <button class="active" data-tab="live">Live · <span id="offers-tab-live-count">–</span></button>
                    <button data-tab="filtered">Filtered · <span id="offers-tab-filtered-count">–</span></button>
                    <button data-tab="next">Next Week · <span id="offers-tab-next-count">–</span></button>
                  </div>
                  <span class="spacer"></span>
                  <div class="toolbar">
                    <label class="search">
                      <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.65" y2="16.65"/></svg>
                      <input id="offers-search" placeholder="Produkt, Kategorie, Marke…" />
                    </label>
                    <div class="seg" id="store-filter"></div>
                  </div>
                </div>
                <div class="table-wrap" style="max-height: 620px">
                  <table class="tbl" id="offers-table">
                    <thead><tr>
                      <th class="left" style="width: 32px"><input type="checkbox" id="offers-select-all" /></th>
                      <th class="left">Produkt</th>
                      <th class="left">Store</th>
                      <th>Preis</th>
                      <th class="left">Kategorie</th>
                      <th class="left">Quelle</th>
                      <th class="left">Bild</th>
                      <th class="left">N · H · A</th>
                      <th class="left">Gültig bis</th>
                      <th class="left">Aktion</th>
                    </tr></thead>
                    <tbody></tbody>
                  </table>
                </div>
              </section>
            </div>
          </div>

          <!-- 3 · Datenqualität -->
          <div class="screen" data-screen="quality">
            <div class="page">
              <div class="page-head">
                <div>
                  <h1>Datenqualität</h1>
                  <div class="page-sub" id="quality-meta">–</div>
                  <div class="page-sub" id="quality-ai-status" style="margin-top:4px">Letzter KI-Lauf: –</div>
                  <div class="page-sub" id="quality-ai-compare" style="margin-top:2px"></div>
                </div>
                <span class="spacer"></span>
                <div class="actions">
                  <button class="btn" data-action="quality-download"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>JSON</button>
                  <button class="btn" data-action="quality-refresh">Neu berechnen</button>
                  <button class="btn" id="quality-ai-btn-incremental" data-action="quality-ai-improve-incremental" title="Prüft nur fehlende/unsichere Produktdaten; gleiche Produkte werden wiederverwendet — deutlich schneller."><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 4 21 9 16 9"/></svg>Nur neue/unklare prüfen</button>
                  <button class="btn primary" id="quality-ai-btn" data-action="quality-ai-improve" title="Analysiert ALLE passenden Angebote neu mit KI (Vollscan für Qualitätsvergleich/Stresstest — kann lange dauern)."><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>Alles neu mit KI prüfen</button>
                  <button class="btn danger" id="quality-ai-cancel-btn" data-action="quality-ai-cancel" title="Bricht den laufenden KI-Lauf ab und beendet den Python-Prozess." style="display:none"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>KI-Lauf abbrechen</button>
                </div>
              </div>

              <!-- KI-Rescan Store-Scope: leer = alle Stores. Chips kommen aus state.quality.stores. -->
              <div class="store-scope" id="quality-store-scope">
                <span class="store-scope-label">KI-Scope</span>
                <div class="store-scope-chips" id="quality-store-scope-chips"></div>
              </div>

              <section class="section">
                <div class="kpi-bar" id="quality-kpi"></div>
                <div class="panel" style="margin-bottom:12px">
                  <div class="panel-head">
                    <h3>Produktinfos · KI/Regel-Analyse</h3>
                    <span class="panel-meta" id="productinfo-meta">–</span>
                  </div>
                  <div id="quality-productinfo" style="display:flex;flex-wrap:wrap;gap:8px"></div>
                  <div style="margin-top:8px;font-size:11px;color:var(--muted)">Ehrlich: <strong>verifiziert</strong> = echte Quelle · <strong>geschätzt/Risiko</strong> = Heuristik · <strong>unklar</strong> = offen/Review (kein Fehler). Kategorie bleibt der einzige harte Blocker.</div>
                </div>
                <div class="section-body">
                  <div class="panel">
                    <div class="panel-head">
                      <h3>Pro Supermarkt</h3>
                      <span class="panel-meta" id="quality-store-meta">– Stores</span>
                    </div>
                    <div class="table-wrap">
                      <table class="tbl" id="quality-store-table">
                        <thead><tr>
                          <th class="left">Store</th>
                          <th>Angebote</th>
                          <th title="Angebote mit Produktbild-URL (URL vorhanden — sagt noch nichts über Erreichbarkeit)">Bild</th>
                          <th title="Bild-URL erreichbar UND image/* (Phase-1-Check). Leer, solange kein Scan 2.0 lief.">Erreichbar</th>
                          <th title="Bild-URL vorhanden, aber 404/kein image/* — Broken Image (EDEKA-Fall)">Broken</th>
                          <th title="Angebote mit gültigem aktuellem Angebotspreis (App-Blocker)">Akt. Preis</th>
                          <th title="Angebote mit UVP/Streichpreis — Anreicherung">Streichpreis</th>
                          <th title="Angebote mit berechnetem Rabatt — Anreicherung">Rabatt</th>
                          <th title="Nährwerte — Anreicherung offen">Nutrition</th>
                          <th title="Allergene — Anreicherung offen">Allerg.</th>
                          <th title="Halal yes/no — Anreicherung offen">Halal</th>
                          <th title="Anteil ohne echte Kategorie (other/Sonstiges)">Ohne Kat.</th>
                          <th>Status</th>
                        </tr></thead>
                        <tbody></tbody>
                      </table>
                    </div>
                  </div>
                  <div class="panel">
                    <div class="panel-head">
                      <h3>Braucht Review</h3>
                      <span class="panel-meta" id="review-meta">– Items</span>
                    </div>
                    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px" id="review-filter"></div>
                    <div class="review-list" id="review-list"></div>
                  </div>
                </div>
              </section>

              <section class="section">
                <div class="section-head">
                  <h2>Offer-History · Retention</h2>
                  <span class="meta" id="history-meta">– gespeicherte Beobachtungen</span>
                  <span class="spacer"></span>
                  <div class="actions">
                    <button class="btn" data-action="history-refresh">Neu laden</button>
                  </div>
                </div>
                <div id="history-banner"></div>
                <div class="kpi-bar cols-4" id="history-kpi"></div>
                <div class="panel">
                  <div class="panel-head">
                    <h3>Scan-Runs</h3>
                    <span class="panel-meta">aus <code>offer_scan_runs</code> · letzte Sync-L&auml;ufe pro KW</span>
                  </div>
                  <div id="history-runs"></div>
                </div>
                <div class="panel">
                  <div class="panel-head">
                    <h3>Kalenderwochen</h3>
                    <span class="panel-meta">KW anklicken &rarr; Angebote dieser Woche laden</span>
                  </div>
                  <div id="history-weeks"></div>
                  <div id="history-week-detail" class="kw-detail"></div>
                  <div style="margin-top:8px;font-size:11px;color:var(--muted)">Retention: Offer-History 12 Monate · Preisverlauf 12 Monate · Raw OCR 30 Tage · siehe <code>docs/admin-v2-release-checklist.md</code></div>
                </div>
              </section>
            </div>
          </div>

          <!-- 4 · Trends -->
          <div class="screen" data-screen="trends">
            <div class="page">
              <div class="page-head">
                <div>
                  <h1>Trends</h1>
                  <div class="page-sub"><span class="pill">Anonym · keine personenbezogenen Daten</span></div>
                </div>
                <span class="spacer"></span>
                <div class="actions">
                  <button class="btn" data-action="trends-refresh">Neu laden</button>
                </div>
              </div>

              <section class="section">
                <div id="trends-banner"></div>
                <div class="section-body equal">
                  <div class="panel">
                    <div class="panel-head"><h3>Top Produkte — Einkaufsliste</h3><span class="panel-meta">aggregiert · 30 Tage</span></div>
                    <div class="rank-list" id="trend-list-1"></div>
                  </div>
                  <div class="panel">
                    <div class="panel-head"><h3>Top Produkte — gekauft</h3><span class="panel-meta">purchased_at gesetzt</span></div>
                    <div class="rank-list" id="trend-list-2"></div>
                  </div>
                </div>
                <div class="section-body equal">
                  <div class="panel">
                    <div class="panel-head"><h3>Top Rezepte — geplant</h3><span class="panel-meta">weekly_plan_entries · 30 d</span></div>
                    <div class="rank-list" id="trend-list-3"></div>
                  </div>
                  <div class="panel">
                    <div class="panel-head"><h3>Top Rezepte — gekocht</h3><span class="panel-meta">recipe_cooked_log · 30 d</span></div>
                    <div class="rank-list" id="trend-list-4"></div>
                  </div>
                </div>
              </section>

              <section class="section">
                <div class="section-head"><h2>Store Trends</h2><span class="meta">aus shopping_list_items.store_name</span></div>
                <div class="table-wrap">
                  <table class="tbl" id="store-trend-table">
                    <thead><tr>
                      <th class="left">Store</th>
                      <th>Treffer</th>
                    </tr></thead>
                    <tbody></tbody>
                  </table>
                </div>
              </section>
            </div>
          </div>

          <!-- 5 · Nutzer & Abos -->
          <div class="screen" data-screen="users">
            <div class="page">
              <div class="page-head">
                <div>
                  <h1>Nutzer &amp; Abos</h1>
                  <div class="page-sub"><span class="pill">Aggregate · keine PII</span></div>
                </div>
                <span class="spacer"></span>
                <div class="actions">
                  <button class="btn" data-action="subscriptions-refresh">Neu laden</button>
                </div>
              </div>

              <section class="section">
                <div class="kpi-bar cols-4" id="users-kpi"></div>
                <div class="section-body equal">
                  <div class="panel">
                    <div class="panel-head"><h3>Plan-Verteilung</h3><span class="panel-meta">aktive Nutzer</span></div>
                    <div id="plan-dist"></div>
                  </div>
                  <div class="panel">
                    <div class="panel-head"><h3>Stripe Webhook Health</h3><span class="panel-meta">stripe_events</span></div>
                    <div id="stripe-health"></div>
                  </div>
                </div>
              </section>

              <section class="section">
                <div class="section-head">
                  <h2>Subscription-Events</h2>
                  <span class="meta" id="users-events-meta">aggregiert · keine PII</span>
                  <span class="spacer"></span>
                  <div class="actions">
                    <button class="btn" data-action="users-events-refresh">Neu laden</button>
                  </div>
                </div>
                <div id="users-events-banner"></div>
                <div id="users-events-host" class="panel"></div>
              </section>
            </div>
          </div>

          <!-- 6 · KI & Jobs -->
          <div class="screen" data-screen="ai">
            <div class="page">
              <div class="page-head">
                <div>
                  <h1>KI &amp; Jobs</h1>
                  <div class="page-sub" id="ai-meta">–</div>
                </div>
                <span class="spacer"></span>
                <div class="actions">
                  <span class="model-combo" style="position:relative;display:inline-flex;align-items:center">
                    <input id="ollama-model-input" list="ollama-model-options" autocomplete="off" placeholder="qwen3:14b" title="Installiertes Modell wählen oder eigenes eintragen" style="border:1px solid var(--line);background:var(--bg-a);color:var(--ink);padding:6px 28px 6px 10px;border-radius:8px;font-size:13px;min-width:220px" />
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="position:absolute;right:9px;width:14px;height:14px;color:var(--muted);pointer-events:none"><polyline points="6 9 12 15 18 9"/></svg>
                    <datalist id="ollama-model-options"></datalist>
                  </span>
                  <button class="btn" data-action="ollama-model-save">Als Scan-Modell</button>
                  <button class="btn" data-action="ollama-pull">Modell laden</button>
                  <button class="btn" data-action="ollama-start">Ollama Start</button>
                  <button class="btn" data-action="ollama-stop">Ollama Stop</button>
                  <button class="btn primary" id="ai-rescan-btn" data-action="ai-rescan">KI Scan starten</button>
                  <button class="btn danger" id="ai-rescan-cancel-btn" data-action="ai-rescan-cancel" title="Bricht den laufenden KI-Scan ab." style="display:none">KI-Scan abbrechen</button>
                </div>
              </div>

              <section class="section">
                <div class="kpi-bar cols-4" id="ai-kpi"></div>
                <div class="section-body equal">
                  <div class="panel">
                    <div class="panel-head"><h3>Ollama Service</h3><span class="panel-meta">lokal</span></div>
                    <div id="ollama-detail"></div>
                  </div>
                  <div class="panel">
                    <div class="panel-head"><h3>Pull-/Job-Status</h3><span class="panel-meta">live</span></div>
                    <div id="ollama-models"></div>
                  </div>
                </div>
              </section>

              <section class="section">
                <div class="section-head">
                  <h2>Installierte Modelle</h2>
                  <span class="meta" id="ollama-installed-meta">Probe…</span>
                  <span class="spacer"></span>
                  <div class="actions">
                    <button class="btn" data-action="ollama-models-refresh">Neu prüfen</button>
                  </div>
                </div>
                <div id="ollama-installed"></div>
              </section>

              <section class="section">
                <div class="section-head">
                  <h2>Job-History</h2>
                  <span class="meta" id="jobs-history-meta">In-Memory · Disk-Runs werden zusätzlich gescannt</span>
                </div>
                <div id="job-history"></div>
                <div id="job-history-disk" style="border-top:1px solid var(--line-soft)"></div>
              </section>
            </div>
          </div>

          <!-- 7 · Imports & Quellen -->
          <div class="screen" data-screen="imports">
            <div class="page">
              <div class="page-head">
                <div>
                  <h1>Imports &amp; Quellen</h1>
                  <div class="page-sub" id="imports-meta">–</div>
                </div>
                <span class="spacer"></span>
                <div class="actions">
                  <button class="btn" data-action="sources-refresh">Neu laden</button>
                  <button class="btn primary" id="weekly-scan-btn" data-action="weekly-scan-start" title="Scrapt alle Quellen außer den ausgeschlossenen Stores (Standard: REWE) und prüft danach mit KI (Vollgas)."><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>Wochen-Auto-Scan starten</button>
                  <button class="btn danger" id="weekly-scan-cancel-btn" data-action="weekly-scan-cancel" style="display:none"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>Abbrechen</button>
                </div>
              </div>

              <section class="section">
                <div class="panel" style="margin-bottom:12px">
                  <div class="panel-head">
                    <h3>Wochen-Auto-Scan · Vollgas</h3>
                    <span class="panel-meta" id="weekly-scan-phase-badge">idle</span>
                  </div>
                  <div id="weekly-scan-status" class="page-sub">Noch kein Wochen-Auto-Scan gelaufen.</div>
                  <div style="margin-top:8px;font-size:11.5px;color:var(--muted)">
                    Scrapt automatisch alle angebundenen Quellen, danach KI-Prüfung im High-Quality-Modus.
                    <strong>REWE wird manuell per Browser-Bookmark importiert</strong> (Captcha/403) und bleibt erhalten.
                  </div>
                </div>

                <div class="panel" style="margin-bottom:12px">
                  <div class="panel-head">
                    <h3>Lidl Prospektbilder (OCR/Vision + Bildsuche)</h3>
                    <span class="panel-meta" id="lidl-page-image-import-badge">idle</span>
                  </div>
                  <div id="lidl-page-image-import-status" class="page-sub">Noch kein Lauf gestartet.</div>
                  <div style="margin-top:8px;font-size:11.5px;color:var(--muted)">
                    Liest Lidls reine Prospekt-BILDSEITEN (die eigentlichen Frische-/Lebensmittelangebote —
                    das strukturierte Prospekt-JSON ist fast nur Wein/Non-Food) per OCR/Vision aus und sucht
                    für jedes gefundene Produkt ein echtes Foto per Google-Bildsuche statt des unscharfen
                    Prospekt-Seitenbilds. <strong>Separat vom Wochen-Auto-Scan</strong> (kann mehrere Minuten
                    dauern) — die 142 bereits funktionierenden strukturierten Lidl-Angebote bleiben unangetastet.
                  </div>
                  <div style="margin-top:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                    <button class="btn primary" id="lidl-page-image-import-btn" data-action="lidl-page-image-import-start" title="Startet den Lidl-Prospektbilder-Import als Hintergrund-Job.">Import starten</button>
                    <label style="font-size:11.5px;color:var(--muted);display:flex;align-items:center;gap:5px">
                      <input type="checkbox" id="lidl-page-image-import-dryrun" />
                      Dry-Run (nur zählen, nichts übernehmen)
                    </label>
                  </div>
                </div>

                <div class="section-head">
                  <h2>Supermarkt-Quellen</h2>
                  <span class="meta" id="sources-table-meta">– Quellen</span>
                </div>
                <div class="table-wrap">
                  <table class="tbl" id="sources-table">
                    <thead><tr>
                      <th class="left">Quelle</th>
                      <th class="left">Typ</th>
                      <th>Angebote</th>
                      <th>Bild %</th>
                      <th class="left">Letzte Aktualisierung</th>
                      <th class="left">Status</th>
                      <th class="left">Warnungen</th>
                    </tr></thead>
                    <tbody></tbody>
                  </table>
                </div>
              </section>

              <section class="section">
                <div class="section-head">
                  <h2>Import-Health pro Shop</h2>
                  <span class="meta" id="import-health-meta">– Shops</span>
                </div>
                <div style="margin-bottom:8px;font-size:11.5px;color:var(--muted)">
                  Strategie &amp; Web-Verifizierung je Store aus dem Scan-Report:
                  <strong>REWE</strong> = manueller Browser-Bookmark-Import (kein Web-Scan),
                  <strong>Lidl/EDEKA/Netto</strong> = ehrliche Teilabdeckung (Prospekt-/national-/
                  Filial-Highlights), <strong>Kaufland</strong> mit Vollständigkeits-Check.
                </div>
                <div class="table-wrap">
                  <table class="tbl" id="import-health-table">
                    <thead><tr>
                      <th class="left">Store</th>
                      <th class="left">Strategie</th>
                      <th title="Aktuelle Angebote">current</th>
                      <th title="Nächste Woche">next</th>
                      <th title="Sichtbare Lebensmittel">food</th>
                      <th title="Gefilterte Non-Food">non-food</th>
                      <th title="Geschätzt fehlende Angebote">fehlt~</th>
                      <th title="Bilder mit kaputtem Link">broken</th>
                      <th class="left" title="Web-Verifizierung der Quelle">Web</th>
                      <th class="left">Health</th>
                    </tr></thead>
                    <tbody></tbody>
                  </table>
                </div>
              </section>

              <section class="section">
                <div class="section-body">
                  <div class="panel">
                    <div class="panel-head"><h3>Hinweise je Quelle</h3><span class="panel-meta">aktuelle Probleme</span></div>
                    <div id="sources-warnings-host"></div>
                  </div>
                </div>
              </section>
            </div>
          </div>

          <!-- 8 · System & Logs -->
          <div class="screen" data-screen="system">
            <div class="page">
              <div class="page-head">
                <div>
                  <h1>System &amp; Logs</h1>
                  <div class="page-sub">Backend · Mobile · Ollama · Supabase</div>
                </div>
                <span class="spacer"></span>
                <div class="actions">
                  <button class="btn" data-action="system-refresh">Refresh</button>
                  <button class="btn" data-action="logs-reload">Logs neu</button>
                  <button class="btn danger" data-action="logs-clear">Logs leeren</button>
                </div>
              </div>

              <section class="section">
                <div class="section-head"><h2>Services</h2><span class="meta">Live-Status</span></div>
                <div class="svc-grid" id="svc-grid"></div>
              </section>

              <section class="section">
                <div class="section-body equal">
                  <div class="panel">
                    <div class="panel-head"><h3>Mobile · Expo</h3><span class="panel-meta">expo start</span></div>
                    <div id="mobile-info"></div>
                  </div>
                  <div class="panel">
                    <div class="panel-head"><h3>Client Errors</h3><span class="panel-meta" id="client-err-meta">– in 24 h</span></div>
                    <div id="client-errors"></div>
                  </div>
                </div>
              </section>

              <section class="section">
                <div class="section-head">
                  <h2>Debug Logs</h2>
                  <span class="meta">letzte 300 Einträge</span>
                  <span class="spacer"></span>
                  <div class="actions">
                    <div class="seg" id="log-level-filter">
                      <button class="active" data-level="all">Alle</button>
                      <button data-level="error">Error</button>
                      <button data-level="warn">Warn</button>
                      <button data-level="info">Info</button>
                    </div>
                  </div>
                </div>
                <div class="panel"><div class="logs" id="logs">Noch keine Logs.</div></div>
              </section>
            </div>
          </div>

          <!-- 9 · Spec / Übergabe -->
          <div class="screen" data-screen="spec">
            <div class="page">
              <div class="page-head">
                <div>
                  <h1>Komponenten &amp; Übergabe</h1>
                  <div class="page-sub">Mapping zwischen UI-Komponenten und echten Backend-Endpunkten</div>
                </div>
              </div>

              <section class="section">
                <div class="section-head"><h2>Komponenten</h2><span class="meta">7 wiederverwendbare Bausteine</span></div>
                <div class="section-body equal">
                  <div class="panel">
                    <div class="spec-block"><h4>KPI Card</h4><p>Label (UPPERCASE 11px) · Wert (22px, tabular) · entweder Sub-Text <em>oder</em> 3px Mini-Bar. Status-Dot vor dem Label. <code>tier ∈ {ok|warn|crit|info|neutral}</code>.</p></div>
                    <div class="spec-block"><h4>Status Badge</h4><p>Pill, 11px, fett. Hintergrund <code>--*-light</code>, Text <code>--*</code>. Mit 6px Dot links. Tiers: ok / warn / crit / info / neutral.</p></div>
                    <div class="spec-block"><h4>Action Button</h4><p>Default: weiß, 1px Border, Radius 8. <code>.primary</code> = brand fill. <code>.danger</code> = Text/Border rot. <code>.ghost</code> = transparent.</p></div>
                    <div class="spec-block"><h4>Health Table</h4><p>Sticky Header, Tabular Nums, 12.5px. Mini-Bars 48×3px in <code>.pct-cell</code> mit Tier-Färbung. Low-Row mit <code>inset 3px var(--warn)</code>.</p></div>
                  </div>
                  <div class="panel">
                    <div class="spec-block"><h4>Review Row</h4><p>Card 8px Radius. Title links, Meta rechts (Store · Cat · Preis). Reason-Tags als 10.5px Pills, <code>.hard</code> rot, <code>.risk</code> gelb.</p></div>
                    <div class="spec-block"><h4>Trend Row</h4><p>Rang (1–10), Name, 4px Bar, Count. Rang #1 in brand-Farbe. Anonyme Aggregate — nie Username/UserId.</p></div>
                    <div class="spec-block"><h4>Job Row</h4><p>Icon-Tile 24px, Name + Detail, Meta (Dauer), Progress-Bar 110px. Tier-Klasse <code>.running/.ok/.crit</code> färbt nur das Icon-Tile.</p></div>
                    <div class="spec-block"><h4>Attention Row</h4><p>3px Akzent links in Tier-Farbe, Icon-Tile in Tier-Light, Body 2-zeilig, Aktion rechts als brand-Link.</p></div>
                  </div>
                </div>
              </section>

              <section class="section">
                <div class="section-head"><h2>Endpunkte (echt)</h2><span class="meta">implementiert</span></div>
                <div class="panel">
                  <ul class="spec-list">
                    <li><code>GET /api/admin/overview</code> — KPIs + Warnungen + Supabase-Status</li>
                    <li><code>GET /api/admin/subscriptions</code> — Counts pro Tier/Status, Stripe-Health (Supabase optional)</li>
                    <li><code>GET /api/admin/trends</code> — Top-Produkte/Rezepte aus den 30-Tage-Views (Supabase optional)</li>
                    <li><code>GET /api/admin/sources</code> — Pro Connector × Store, Coverage + Warnungen</li>
                    <li><code>GET /api/admin/jobs</code> — Aktuelle Process-States + History</li>
                    <li><code>GET /api/offers</code> — Live/Filtered/Next-Week Listen</li>
                    <li><code>GET /api/offers/quality</code> — Volle QualityReport</li>
                    <li><code>GET /api/system/status</code> · <code>GET /api/debug/logs</code></li>
                  </ul>
                </div>
              </section>

              <section class="section">
                <div class="section-head"><h2>Endpunkte (geplant)</h2><span class="meta">noch nicht implementiert</span></div>
                <div class="panel">
                  <ul class="spec-list">
                    <li><code>GET /api/admin/users/events</code> — Aggregierte Subscription-Events mit maskierten E-Mails</li>
                    <li><code>GET /api/admin/jobs/history</code> — Persistente History aus <code>public.admin_job_runs</code> (Migration noch nicht angelegt)</li>
                    <li><code>GET /api/admin/ollama/models</code> — Liste verfügbarer Modelle aus Ollama API</li>
                    <li>Globale Suche ⌘K über Angebote/Quellen/Logs</li>
                    <li>Snapshot-Diff zwischen zwei Quality-Reports</li>
                    <li>Audit-Log für alle Admin-Aktionen</li>
                  </ul>
                </div>
              </section>

              <section class="section">
                <div class="section-head"><h2>Bekannte Lücken</h2><span class="meta">echte Datenqualität</span></div>
                <div class="panel">
                  <ul class="spec-list">
                    <li>Nutrition/Halal/Allergene werden derzeit fast nicht befüllt (Pipeline läuft nur via Angebots-Scan 1.0 oder Phase 2 von Angebots-Scan 2.0)</li>
                    <li><code>recipe_cooked_log</code> ist meist leer — Mobile triggert noch keinen Cooked-Event</li>
                    <li><code>shopping_list_items.purchased_at</code> ist optional und oft null</li>
                    <li>Job-History ist In-Memory und geht beim Backend-Neustart verloren</li>
                    <li>Wenn das Dashboard remote erreichbar wird, ist Auth/Admin-Schutz Pflicht</li>
                  </ul>
                </div>
              </section>
            </div>
          </div>

          <!-- 10 · Cheffity Rezepte -->
          <div class="screen" data-screen="recipes">
            <div class="page">
              <div class="page-head">
                <div>
                  <h1>Cheffity Rezepte</h1>
                  <div class="page-sub" id="recipes-meta">–</div>
                </div>
                <span class="spacer"></span>
                <div class="actions">
                  <button class="btn" data-action="recipes-refresh">Neu laden</button>
                </div>
              </div>

              <!-- Cheffity-Angebotsverbindung: deals ⇄ recipe_ingredients Qualität -->
              <section class="section" id="offer-quality-section">
                <div class="section-head">
                  <h2>Cheffity-Angebotsverbindung</h2>
                  <span class="meta" id="offer-quality-meta">–</span>
                  <span class="spacer"></span>
                  <div class="actions">
                    <button class="btn" data-action="cheffity-match-dry" title="Matcher-Vorschau ohne Schreiben (dryRun)">Dry Run Matcher</button>
                    <button class="btn primary" data-action="cheffity-match-write" title="Matcher ausführen und deal_recipe_matches schreiben">Matcher schreiben</button>
                    <button class="btn" data-action="offer-quality-refresh">Neu laden</button>
                  </div>
                </div>
                <div id="offer-quality-banner"></div>
                <div class="kpi-bar" id="offer-quality-kpi"></div>
                <div class="section-body">
                  <div class="panel">
                    <div class="panel-head"><h3>Ungematchte Angebote</h3><span class="panel-meta" id="oq-unmatched-deals-meta">–</span></div>
                    <div id="oq-unmatched-deals"></div>
                  </div>
                  <div class="panel">
                    <div class="panel-head"><h3>Ungematchte Rezeptzutaten</h3><span class="panel-meta" id="oq-unmatched-ingredients-meta">–</span></div>
                    <div id="oq-unmatched-ingredients"></div>
                  </div>
                  <div class="panel">
                    <div class="panel-head"><h3>Review-Kandidaten</h3><span class="panel-meta" id="oq-review-meta">–</span></div>
                    <div id="oq-review"></div>
                  </div>
                  <div class="panel">
                    <div class="panel-head"><h3>Verdächtige Matches</h3><span class="panel-meta" id="oq-suspicious-meta">–</span></div>
                    <div id="oq-suspicious"></div>
                  </div>
                </div>
              </section>

              <section class="section">
                <div id="recipes-banner"></div>
                <div class="section-head">
                  <div style="display:flex;flex-wrap:wrap;gap:6px" id="recipes-filter"></div>
                  <span class="spacer"></span>
                  <div class="toolbar">
                    <label class="search">
                      <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.65" y2="16.65"/></svg>
                      <input id="recipes-search" placeholder="Rezeptname…" />
                    </label>
                  </div>
                </div>
                <div class="section-head" style="margin-top:-4px">
                  <span class="muted" style="font-size:12px;align-self:center">Küche:</span>
                  <div style="display:flex;flex-wrap:wrap;gap:6px" id="recipes-cuisine-filter"></div>
                </div>
                <div class="table-wrap" style="max-height: 640px">
                  <table class="tbl" id="recipes-table">
                    <thead><tr>
                      <th class="left">Rezept</th>
                      <th class="left">Status</th>
                      <th class="left">Herkunft</th>
                      <th class="left">Review</th>
                      <th class="left">Küche</th>
                      <th class="left">Meal</th>
                      <th>Zeit</th>
                      <th class="left">Tags / Diät</th>
                      <th class="left">Warnungen</th>
                      <th class="left">Aktion</th>
                    </tr></thead>
                    <tbody></tbody>
                  </table>
                </div>
              </section>
            </div>
          </div>

        </div>
      </main>
    </div>
  `;
}
