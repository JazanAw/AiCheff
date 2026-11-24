// Inline CSS for /admin-v2. Tokens + components ported 1:1 from the Claude
// Design "Control Center.html" handoff (Mai 2026). Dense, professional,
// operations-first — brand-Orange nur als Akzent, dunkle Sidebar mit
// gruppierter Nav, Light + Dark Theme.

export const adminDashboardStyles = `
  :root {
    --bg-a: #FFFFFF;
    --bg-b: #F8FAFC;
    --bg-c: #F1F5F9;
    --card: #FFFFFF;
    --line: #E5E7EB;
    --line-soft: #F1F3F5;
    --ink: #1A1A1A;
    --ink-2: #374151;
    --muted: #6B7280;
    --muted-2: #9CA3AF;
    --brand: #FF6B35;
    --brand-light: #FFF0EB;
    --brand-dark: #E55A2B;
    --danger: #EF4444;
    --danger-light: #FEF2F2;
    --ok: #10B981;
    --ok-light: #ECFDF5;
    --warn: #F59E0B;
    --warn-light: #FFFBEB;
    --info: #3B82F6;
    --info-light: #EFF6FF;
    --neutral-bar: #E5E7EB;
    --sidebar: #0F1115;
    --sidebar-ink: #E5E7EB;
    --sidebar-muted: #8B92A0;
    --sidebar-line: #1E2128;
    --sidebar-hover: #1A1D24;
  }
  [data-theme='dark'] {
    --bg-a: #0F0F11;
    --bg-b: #16171A;
    --bg-c: #1B1C20;
    --card: #1E1F23;
    --line: #2D2E33;
    --line-soft: #25262B;
    --ink: #F5F5F6;
    --ink-2: #D1D5DB;
    --muted: #9CA3AF;
    --muted-2: #6B7280;
    --brand: #FF7A4A;
    --brand-light: #2A1810;
    --brand-dark: #FF8A60;
    --danger: #F87171;
    --danger-light: #2A1414;
    --ok: #34D399;
    --ok-light: #0E2A1E;
    --warn: #FBBF24;
    --warn-light: #2A1F0E;
    --info: #60A5FA;
    --info-light: #0E1E3A;
    --neutral-bar: #2D2E33;
    --sidebar: #0A0B0E;
    --sidebar-line: #16171B;
    --sidebar-hover: #14161B;
  }

  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    min-height: 100vh;
    color: var(--ink);
    background: var(--bg-b);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    letter-spacing: -0.01em;
    font-size: 14px;
  }
  ::selection { background: var(--brand); color: #fff; }

  /* ---------- App shell ---------- */
  .app {
    display: grid;
    grid-template-columns: 220px minmax(0, 1fr);
    min-height: 100vh;
  }
  @media (max-width: 900px) {
    .app { grid-template-columns: 1fr; }
  }

  .sidebar {
    background: var(--sidebar);
    color: var(--sidebar-ink);
    border-right: 1px solid var(--sidebar-line);
    display: flex;
    flex-direction: column;
    padding: 12px 10px;
    gap: 4px;
    height: 100vh;
    position: sticky;
    top: 0;
  }
  @media (max-width: 900px) { .sidebar { position: sticky; top: 0; z-index: 30; height: auto; } }

  .sidebar-head {
    display: flex; align-items: center; gap: 9px;
    padding: 6px 8px 14px 8px;
    border-bottom: 1px solid var(--sidebar-line);
    margin-bottom: 6px;
  }
  .sidebar-mark {
    width: 28px; height: 28px;
    border-radius: 7px;
    background: var(--brand);
    color: #fff;
    display: grid; place-items: center;
    font-weight: 800; font-size: 13px;
    letter-spacing: -0.02em;
  }
  .sidebar-title { font-size: 13px; font-weight: 600; letter-spacing: -0.01em; line-height: 1.1; }
  .sidebar-sub {
    font-size: 10.5px;
    color: var(--sidebar-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-top: 2px;
  }
  .nav-group { display: flex; flex-direction: column; gap: 1px; }
  .nav-cat {
    color: var(--sidebar-muted);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    padding: 10px 10px 6px 10px;
    font-weight: 600;
  }
  .nav-item {
    display: flex; align-items: center; gap: 10px;
    padding: 7px 10px;
    border-radius: 7px;
    color: var(--sidebar-ink);
    font-size: 13px; font-weight: 500;
    cursor: pointer; user-select: none;
    border: 1px solid transparent;
    background: transparent;
    width: 100%; text-align: left;
    font-family: inherit;
  }
  .nav-item:hover { background: var(--sidebar-hover); }
  .nav-item .ni-ico {
    width: 16px; height: 16px;
    color: var(--sidebar-muted);
    flex-shrink: 0;
  }
  .nav-item .ni-num {
    margin-left: auto;
    font-size: 10.5px;
    color: var(--sidebar-muted);
    font-variant-numeric: tabular-nums;
    background: var(--sidebar-hover);
    padding: 1px 6px;
    border-radius: 999px;
    font-weight: 600;
  }
  .nav-item.active {
    background: var(--sidebar-hover);
    color: #fff;
    box-shadow: inset 2px 0 0 var(--brand);
  }
  .nav-item.active .ni-ico { color: var(--brand); }
  .nav-item .ni-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--ok);
    margin-left: auto;
  }
  .nav-item .ni-dot.warn { background: var(--warn); }
  .nav-item .ni-dot.crit { background: var(--danger); }
  .nav-item .ni-dot.info { background: var(--info); }

  .sidebar-foot {
    margin-top: auto;
    padding-top: 10px;
    border-top: 1px solid var(--sidebar-line);
    display: flex; flex-direction: column; gap: 6px;
  }
  .env-line {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 10px;
    font-size: 11px;
    color: var(--sidebar-muted);
    font-variant-numeric: tabular-nums;
  }
  .env-line strong { color: #fff; font-weight: 600; }
  .env-line .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); flex-shrink: 0; }

  /* ---------- Topbar + Main ---------- */
  main.shell {
    display: flex; flex-direction: column;
    min-width: 0;
  }
  .topbar {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 18px;
    background: var(--bg-a);
    border-bottom: 1px solid var(--line);
    position: sticky;
    top: 0;
    z-index: 20;
    flex-wrap: wrap;
  }
  .breadcrumb {
    display: flex; align-items: center; gap: 6px;
    color: var(--muted);
    font-size: 13px;
  }
  .breadcrumb strong { color: var(--ink); font-weight: 600; }
  .breadcrumb .sep { color: var(--muted-2); }
  .topbar .spacer { flex: 1; }
  .topbar .global-search {
    display: flex; align-items: center; gap: 6px;
    border: 1px solid var(--line);
    background: var(--bg-b);
    padding: 5px 10px;
    border-radius: 8px;
    min-width: 260px;
    color: var(--muted);
    font-size: 12.5px;
  }
  .topbar .global-search input {
    border: 0; background: transparent;
    font: inherit; color: var(--ink);
    outline: 0; flex: 1; min-width: 0;
  }
  .topbar .kbd, .qa .kbd {
    font-size: 10.5px;
    color: var(--muted);
    background: var(--bg-c);
    padding: 1px 5px;
    border-radius: 4px;
    border: 1px solid var(--line);
    font-variant-numeric: tabular-nums;
  }
  .topbar button.icon-btn {
    border: 1px solid var(--line);
    background: var(--bg-a);
    color: var(--ink-2);
    padding: 6px 10px;
    border-radius: 8px;
    font: inherit; font-size: 13px;
    cursor: pointer;
    display: inline-flex; align-items: center; gap: 6px;
  }
  .topbar button.icon-btn:hover { border-color: var(--muted); color: var(--ink); }
  .topbar button.icon-btn svg { width: 14px; height: 14px; }
  .status-bar {
    background: var(--bg-c);
    color: var(--muted);
    padding: 6px 18px;
    font-size: 12px;
    border-bottom: 1px solid var(--line-soft);
  }
  .status-bar[data-kind='ok'] { color: var(--ok); background: var(--ok-light); }
  .status-bar[data-kind='warn'] { color: var(--warn); background: var(--warn-light); }
  .status-bar[data-kind='error'] { color: var(--danger); background: var(--danger-light); }

  /* ---------- Page container ---------- */
  .page {
    padding: 14px 18px 32px 18px;
    display: grid; gap: 12px;
    max-width: 1600px; width: 100%;
    margin: 0 auto;
  }
  .page-head {
    display: flex; align-items: flex-end; gap: 12px;
    padding: 2px 0 4px 0; flex-wrap: wrap;
  }
  .page-head h1 {
    margin: 0;
    font-size: 19px; font-weight: 700;
    letter-spacing: -0.02em;
  }
  .page-head .page-sub {
    color: var(--muted);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }
  .page-head .spacer { flex: 1; }
  .page-head .actions { display: flex; gap: 8px; flex-wrap: wrap; }

  /* ---------- Section card ---------- */
  .section {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 12px;
    overflow: hidden;
  }
  .section-head {
    display: flex; align-items: center; gap: 12px;
    padding: 11px 16px;
    border-bottom: 1px solid var(--line-soft);
    flex-wrap: wrap;
  }
  .section-head h2 {
    margin: 0;
    font-size: 13px; font-weight: 600;
    text-transform: uppercase;
    color: var(--ink);
    letter-spacing: 0.04em;
  }
  .section-head .meta {
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .section-head .spacer { flex: 1; }
  .section-head .actions { display: flex; gap: 6px; flex-wrap: wrap; }

  /* ---------- Buttons ---------- */
  .btn {
    border: 1px solid var(--line);
    background: var(--bg-a);
    color: var(--ink);
    padding: 6px 12px;
    border-radius: 8px;
    font: inherit; font-size: 13px; font-weight: 500;
    cursor: pointer;
    display: inline-flex; align-items: center; gap: 6px;
    line-height: 1.2;
  }
  [data-theme='dark'] .btn { background: var(--bg-c); }
  .btn:hover { border-color: var(--muted); }
  .btn.primary {
    background: var(--brand);
    color: #fff;
    border-color: transparent;
  }
  .btn.primary:hover { background: var(--brand-dark); }
  .btn.danger { color: var(--danger); border-color: var(--line); }
  .btn.danger:hover { background: var(--danger-light); border-color: var(--danger); }
  .btn.ghost { background: transparent; border-color: transparent; color: var(--muted); }
  .btn.ghost:hover { background: var(--bg-c); color: var(--ink); }
  .btn:disabled { opacity: 0.55; cursor: not-allowed; }
  .btn .ico { width: 14px; height: 14px; flex-shrink: 0; }

  /* Angebots-Scan 2.0 split-button + dropdown menu. */
  .split-btn { position: relative; display: inline-flex; }
  .split-btn > .btn { border-radius: 8px; }
  .split-btn > .btn:first-child { border-top-right-radius: 0; border-bottom-right-radius: 0; }
  .split-btn > .split-toggle {
    border-top-left-radius: 0; border-bottom-left-radius: 0;
    border-left: 1px solid rgba(255,255,255,0.35);
    padding-left: 8px; padding-right: 8px;
  }
  .split-toggle .ico { margin: 0; }
  .split-menu {
    position: absolute; top: calc(100% + 4px); right: 0; z-index: 40;
    min-width: 200px; padding: 4px;
    background: var(--bg-a); border: 1px solid var(--line); border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.18); display: flex; flex-direction: column; gap: 2px;
  }
  .split-menu[hidden] { display: none; }
  .split-menu-item {
    text-align: left; background: transparent; border: 0; color: var(--ink);
    padding: 8px 10px; border-radius: 7px; font-size: 13px; cursor: pointer;
  }
  .split-menu-item:hover { background: var(--bg-c); }

  /* ---------- KPI bar ---------- */
  .kpi-bar {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    gap: 1px;
    background: var(--line-soft);
    border-bottom: 1px solid var(--line-soft);
  }
  .kpi-bar.cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .kpi-bar.cols-6 { grid-template-columns: repeat(6, minmax(0, 1fr)); }
  @media (max-width: 1200px) { .kpi-bar, .kpi-bar.cols-6 { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
  @media (max-width: 720px) { .kpi-bar, .kpi-bar.cols-4, .kpi-bar.cols-6 { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  .kpi {
    background: var(--card);
    padding: 12px 14px;
    display: grid;
    gap: 4px;
    grid-template-rows: auto auto auto;
    min-width: 0;
  }
  .kpi-label {
    font-size: 11px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
    display: flex; align-items: center; gap: 6px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .kpi-value-row { display: flex; align-items: baseline; gap: 6px; }
  .kpi-value {
    font-size: 22px; font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }
  .kpi-unit { color: var(--muted); font-size: 13px; font-weight: 500; }
  .kpi-sub { font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* Admin kill-switch on a KPI tile (Nutrition/Halal/Allergene) — shows whether
     the Cheffity app currently gets this category; click to flip it. */
  .kpi-toggle {
    margin-left: auto;
    flex-shrink: 0;
    border: 1px solid var(--line-soft);
    border-radius: 999px;
    padding: 1px 8px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    cursor: pointer;
    background: transparent;
    color: var(--muted);
  }
  .kpi-toggle.on { color: var(--ok); border-color: var(--ok); }
  .kpi-toggle.off { color: var(--danger); border-color: var(--danger); }
  .kpi-toggle:hover { filter: brightness(1.15); }

  /* ---------- Dots ---------- */
  .dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--muted-2);
    flex-shrink: 0;
  }
  .dot.ok { background: var(--ok); }
  .dot.warn { background: var(--warn); }
  .dot.crit { background: var(--danger); }
  .dot.info { background: var(--info); }
  .dot.neutral { background: var(--muted-2); }

  .minibar {
    height: 3px; border-radius: 2px;
    background: var(--neutral-bar);
    overflow: hidden;
    margin-top: 2px;
  }
  .minibar > span { display: block; height: 100%; background: var(--muted-2); border-radius: 2px; }
  .minibar.ok > span { background: var(--ok); }
  .minibar.warn > span { background: var(--warn); }
  .minibar.crit > span { background: var(--danger); }
  .minibar.brand > span { background: var(--brand); }

  /* ---------- Section body ---------- */
  .section-body {
    display: grid;
    grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr);
    gap: 0;
  }
  .section-body.equal { grid-template-columns: minmax(0,1fr) minmax(0,1fr); }
  .section-body.thirds { grid-template-columns: minmax(0,1fr) minmax(0,1fr) minmax(0,1fr); }
  .section-body.single { grid-template-columns: minmax(0,1fr); }
  @media (max-width: 1100px) {
    .section-body, .section-body.equal, .section-body.thirds { grid-template-columns: 1fr; }
  }
  .panel { padding: 14px 16px; min-width: 0; }
  .panel + .panel { border-left: 1px solid var(--line-soft); }
  @media (max-width: 1100px) {
    .panel + .panel { border-left: none; border-top: 1px solid var(--line-soft); }
  }
  .panel-head {
    display: flex; align-items: baseline; justify-content: space-between;
    margin-bottom: 10px; gap: 8px; flex-wrap: wrap;
  }
  .panel-head h3 {
    margin: 0;
    font-size: 12px; font-weight: 600;
    color: var(--ink);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .panel-head .panel-meta { color: var(--muted); font-size: 12px; }

  /* ---------- Tables ---------- */
  .table-wrap {
    border: 1px solid var(--line-soft);
    border-radius: 8px;
    overflow: auto;
    max-height: 560px;
  }
  table.tbl {
    width: 100%;
    border-collapse: collapse;
    font-size: 12.5px;
    font-variant-numeric: tabular-nums;
  }
  table.tbl thead th {
    position: sticky; top: 0; z-index: 2;
    background: var(--bg-c);
    color: var(--muted);
    font-weight: 600;
    text-align: right;
    padding: 9px 10px;
    border-bottom: 1px solid var(--line);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 10.5px;
    white-space: nowrap;
  }
  table.tbl thead th:first-child,
  table.tbl thead th.left { text-align: left; }
  table.tbl tbody td {
    padding: 9px 10px;
    border-bottom: 1px solid var(--line-soft);
    text-align: right;
    white-space: nowrap;
    vertical-align: middle;
  }
  table.tbl tbody tr:last-child td { border-bottom: none; }
  table.tbl tbody tr:hover td { background: var(--bg-b); }
  table.tbl td.left { text-align: left; }
  table.tbl td.bold { font-weight: 600; color: var(--ink); }
  table.tbl td.num { color: var(--ink-2); }

  .store-logo {
    width: 22px; height: 22px;
    border-radius: 5px;
    display: inline-grid; place-items: center;
    font-size: 11px; font-weight: 700;
    color: #fff;
    flex-shrink: 0;
    vertical-align: -6px;
    margin-right: 6px;
  }

  .pct-cell {
    display: inline-flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 3px;
    min-width: 56px;
  }
  .pct-cell .pct-val { font-weight: 500; font-size: 12px; line-height: 1; }
  .pct-cell .pct-bar {
    width: 48px; height: 3px;
    background: var(--neutral-bar);
    border-radius: 2px;
    overflow: hidden;
  }
  .pct-cell .pct-bar > span { display: block; height: 100%; background: var(--muted-2); border-radius: 2px; }
  .pct-cell.ok   .pct-val { color: var(--ok); }      .pct-cell.ok   .pct-bar > span { background: var(--ok); }
  .pct-cell.warn .pct-val { color: var(--warn); }    .pct-cell.warn .pct-bar > span { background: var(--warn); }
  .pct-cell.crit .pct-val { color: var(--danger); }  .pct-cell.crit .pct-bar > span { background: var(--danger); }

  tr.low-store td:first-child { box-shadow: inset 3px 0 0 var(--warn); }
  .low-pill {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--warn-light);
    color: var(--warn);
    font-size: 10.5px;
    font-weight: 600;
    margin-left: 6px;
  }

  /* ---------- Status badges ---------- */
  .status-badge {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 11px; font-weight: 600;
    border: 1px solid transparent;
    white-space: nowrap;
  }
  .status-badge.ok   { background: var(--ok-light);     color: var(--ok); }
  .status-badge.warn { background: var(--warn-light);   color: var(--warn); }
  .status-badge.crit { background: var(--danger-light); color: var(--danger); }
  .status-badge.info { background: var(--info-light);   color: var(--info); }
  .status-badge.neutral { background: var(--bg-c); color: var(--muted); }
  .status-badge .dot { width: 6px; height: 6px; }

  /* ---------- Chips / segments ---------- */
  .chip {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--bg-a);
    color: var(--ink-2);
    font-size: 11.5px; font-weight: 500;
    cursor: pointer; user-select: none;
    line-height: 1.4;
  }
  [data-theme='dark'] .chip { background: var(--bg-c); }
  .chip:hover { border-color: var(--muted); }
  .chip .chip-count {
    font-variant-numeric: tabular-nums;
    color: var(--muted);
    font-weight: 600;
    font-size: 11px;
  }
  .chip.active {
    background: var(--ink);
    color: var(--bg-a);
    border-color: var(--ink);
  }
  .chip.active .chip-count { color: var(--bg-a); opacity: 0.7; }
  .chip:disabled, .chip[disabled] { opacity: 0.5; cursor: not-allowed; }

  /* KI-Rescan store scope selector (Datenqualität). */
  .store-scope {
    display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
    margin-bottom: 12px;
  }
  .store-scope-label {
    font-size: 11px; font-weight: 700; letter-spacing: 0.4px;
    text-transform: uppercase; color: var(--muted);
  }
  .store-scope-chips { display: flex; flex-wrap: wrap; gap: 6px; }

  .seg {
    display: inline-flex;
    border: 1px solid var(--line);
    border-radius: 8px;
    overflow: hidden;
    background: var(--bg-a);
  }
  [data-theme='dark'] .seg { background: var(--bg-c); }
  .seg button {
    border: 0;
    padding: 6px 12px;
    background: transparent;
    color: var(--ink-2);
    font: inherit; font-size: 12.5px;
    cursor: pointer; font-weight: 500;
  }
  .seg button + button { border-left: 1px solid var(--line); }
  .seg button.active { background: var(--ink); color: var(--bg-a); }
  .seg button:not(.active):hover { background: var(--bg-b); }

  /* ---------- Attention list ---------- */
  .attn-list { display: grid; gap: 6px; }
  .attn {
    display: grid;
    grid-template-columns: 22px 1fr auto;
    gap: 10px;
    align-items: center;
    padding: 10px 12px;
    border: 1px solid var(--line-soft);
    border-radius: 8px;
    background: var(--bg-a);
  }
  [data-theme='dark'] .attn { background: var(--bg-c); }
  .attn.crit { border-left: 3px solid var(--danger); }
  .attn.warn { border-left: 3px solid var(--warn); }
  .attn.info { border-left: 3px solid var(--info); }
  .attn-ico {
    width: 22px; height: 22px;
    border-radius: 6px;
    display: grid; place-items: center;
    flex-shrink: 0;
  }
  .attn.crit .attn-ico { background: var(--danger-light); color: var(--danger); }
  .attn.warn .attn-ico { background: var(--warn-light); color: var(--warn); }
  .attn.info .attn-ico { background: var(--info-light); color: var(--info); }
  .attn-ico svg { width: 13px; height: 13px; }
  .attn-body { min-width: 0; }
  .attn-title { font-size: 13px; font-weight: 600; color: var(--ink); line-height: 1.25; }
  .attn-desc { color: var(--muted); font-size: 11.5px; margin-top: 1px; line-height: 1.3; }
  .attn-action { font-size: 12px; color: var(--brand); font-weight: 600; cursor: pointer; }
  .attn-action:hover { text-decoration: underline; }

  /* ---------- Quick actions ---------- */
  .qa-grid { display: grid; gap: 6px; }
  .qa {
    display: grid;
    grid-template-columns: 28px 1fr auto;
    gap: 10px;
    align-items: center;
    padding: 10px 12px;
    border: 1px solid var(--line-soft);
    border-radius: 8px;
    background: var(--bg-a);
    cursor: pointer; text-align: left;
    font: inherit; color: var(--ink);
  }
  [data-theme='dark'] .qa { background: var(--bg-c); }
  .qa:hover { border-color: var(--muted); }
  .qa-ico {
    width: 28px; height: 28px;
    border-radius: 7px;
    background: var(--brand-light);
    color: var(--brand);
    display: grid; place-items: center;
  }
  .qa-ico svg { width: 14px; height: 14px; }
  .qa-title { font-size: 13px; font-weight: 600; color: var(--ink); line-height: 1.2; }
  .qa-desc { font-size: 11px; color: var(--muted); margin-top: 1px; }

  /* ---------- Activity feed ---------- */
  .feed { display: grid; gap: 0; }
  .feed-row {
    display: grid;
    grid-template-columns: 14px 80px 1fr auto;
    gap: 10px;
    align-items: center;
    padding: 7px 0;
    border-bottom: 1px dashed var(--line-soft);
    font-size: 12.5px;
  }
  .feed-row:last-child { border-bottom: 0; }
  .feed-row .feed-time {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    font-size: 11.5px;
  }
  .feed-row .feed-tag {
    font-size: 10.5px;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .feed-row .feed-msg { color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .feed-row .feed-msg code {
    background: var(--bg-c);
    padding: 0 4px;
    border-radius: 3px;
    font-size: 11.5px;
    color: var(--ink);
  }

  /* ---------- Review list (Datenqualität) ---------- */
  .review-list {
    display: grid;
    gap: 6px;
    max-height: 480px;
    overflow: auto;
    padding-right: 4px;
  }
  .review-item {
    border: 1px solid var(--line-soft);
    border-radius: 8px;
    padding: 9px 10px;
    background: var(--bg-a);
    display: grid; gap: 5px;
  }
  [data-theme='dark'] .review-item { background: var(--bg-c); }
  .review-item:hover { border-color: var(--line); }
  .review-top {
    display: flex; justify-content: space-between; align-items: baseline;
    gap: 10px; flex-wrap: wrap;
  }
  .review-name { font-weight: 600; font-size: 13px; color: var(--ink); line-height: 1.3; }
  .review-meta {
    color: var(--muted);
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
    display: flex; gap: 6px; align-items: center; flex-wrap: wrap;
  }
  .review-meta .dotmini { width: 3px; height: 3px; border-radius: 50%; background: var(--muted-2); }
  .review-tags { display: flex; flex-wrap: wrap; gap: 4px; }
  .reason-tag {
    font-size: 10.5px;
    padding: 2px 7px;
    border-radius: 999px;
    border: 1px solid transparent;
    font-weight: 500;
    line-height: 1.4;
  }
  .reason-tag.hard { background: var(--danger-light); color: var(--danger); }
  .reason-tag.risk { background: var(--warn-light); color: var(--warn); }
  .review-foot a {
    color: var(--brand);
    text-decoration: none;
    font-weight: 500;
    font-size: 11.5px;
  }
  .review-foot a:hover { text-decoration: underline; }

  /* ---------- Offer table specifics ---------- */
  .toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .toolbar .search {
    display: flex; align-items: center; gap: 6px;
    border: 1px solid var(--line);
    background: var(--bg-a);
    padding: 5px 10px;
    border-radius: 8px;
    min-width: 220px;
    color: var(--muted);
    font-size: 12.5px;
  }
  .toolbar .search input {
    border: 0; background: transparent;
    font: inherit; color: var(--ink);
    outline: 0; flex: 1; min-width: 0;
  }
  [data-theme='dark'] .toolbar .search { background: var(--bg-c); }

  .thumb {
    width: 38px; height: 38px;
    border-radius: 6px;
    background: var(--bg-c);
    display: inline-grid; place-items: center;
    color: var(--muted-2);
    overflow: hidden;
    vertical-align: -10px;
    margin-right: 8px;
  }
  .thumb svg { width: 14px; height: 14px; }
  .thumb.has-img { background: #fff; border: 1px solid var(--line-soft); }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
  }
  .thumb.no { background: var(--danger-light); color: var(--danger); }

  .name-cell { display: flex; align-items: center; gap: 0; min-width: 240px; }
  .name-text { display: grid; gap: 1px; }
  .name-text .nm { font-weight: 600; color: var(--ink); font-size: 12.5px; }
  .name-text .sb { font-size: 11px; color: var(--muted); }

  .price-cell { font-weight: 600; color: var(--ink); }
  .price-cell .old { color: var(--muted); text-decoration: line-through; font-weight: 400; font-size: 11.5px; margin-right: 6px; }

  .meta-icons { display: inline-flex; gap: 3px; }
  .mi {
    width: 18px; height: 18px;
    border-radius: 4px;
    background: var(--bg-c);
    color: var(--muted-2);
    display: grid; place-items: center;
    font-size: 9px; font-weight: 700;
    letter-spacing: 0;
  }
  .mi.ok { background: var(--ok-light); color: var(--ok); }
  .mi.warn { background: var(--warn-light); color: var(--warn); }
  .mi.crit { background: var(--danger-light); color: var(--danger); }
  .mi.neutral { background: var(--bg-c); color: var(--muted); }

  /* ---------- Trends / rank list ---------- */
  .rank-list {
    display: grid; gap: 1px;
    background: var(--line-soft);
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid var(--line-soft);
  }
  .rank-row {
    display: grid;
    grid-template-columns: 22px 1fr 60px 80px;
    gap: 10px;
    align-items: center;
    padding: 8px 10px;
    background: var(--card);
    font-size: 12.5px;
  }
  .rank-row .rnk {
    font-variant-numeric: tabular-nums;
    color: var(--muted);
    font-size: 11px;
    font-weight: 700;
  }
  .rank-row .nm {
    font-weight: 500; color: var(--ink);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .rank-row .ct {
    text-align: right; font-variant-numeric: tabular-nums;
    color: var(--ink-2); font-weight: 600;
  }
  .rank-row .bar {
    height: 4px; background: var(--neutral-bar);
    border-radius: 2px; overflow: hidden;
  }
  .rank-row .bar > span { display: block; height: 100%; background: var(--brand); }
  .rank-row.r1 .rnk { color: var(--brand); }

  /* ---------- Empty / placeholder banners ---------- */
  .empty {
    color: var(--muted);
    font-style: italic;
    font-size: 13px;
    padding: 20px 0;
    text-align: center;
  }
  .nodata-banner {
    margin: 0;
    padding: 9px 12px;
    background: var(--info-light);
    color: var(--info);
    border-bottom: 1px solid var(--line-soft);
    font-size: 12px;
    display: flex; align-items: center; gap: 8px;
  }
  .nodata-banner.warn { background: var(--warn-light); color: var(--warn); }
  .nodata-banner.crit { background: var(--danger-light); color: var(--danger); }
  .nodata-banner svg { width: 14px; height: 14px; flex-shrink: 0; }
  .nodata-banner strong { font-weight: 600; }
  .planned-pill {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--info-light); color: var(--info);
    font-size: 10px; font-weight: 700;
    letter-spacing: 0.03em; text-transform: uppercase;
  }

  /* ---------- Job rows ---------- */
  .job-row {
    display: grid;
    grid-template-columns: 24px 1.5fr 1fr 90px 110px auto;
    gap: 12px;
    align-items: center;
    padding: 10px 12px;
    border-bottom: 1px solid var(--line-soft);
    font-size: 12.5px;
  }
  .job-row:last-child { border-bottom: 0; }
  .job-row .j-ico {
    width: 24px; height: 24px;
    border-radius: 6px;
    display: grid; place-items: center;
    background: var(--bg-c);
    color: var(--ink-2);
  }
  .job-row.running .j-ico { background: var(--info-light); color: var(--info); }
  .job-row.ok .j-ico      { background: var(--ok-light);   color: var(--ok); }
  .job-row.crit .j-ico    { background: var(--danger-light); color: var(--danger); }
  .job-row .j-name { font-weight: 600; color: var(--ink); }
  .job-row .j-detail { color: var(--muted); font-size: 11.5px; }
  .job-row .j-meta { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 11.5px; }
  .progress {
    height: 4px;
    background: var(--neutral-bar);
    border-radius: 2px;
    overflow: hidden;
    width: 110px;
    margin-top: 4px;
  }
  .progress > span { display: block; height: 100%; background: var(--brand); transition: width .3s; }

  /* ---------- Service grid ---------- */
  .svc-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1px;
    background: var(--line-soft);
  }
  @media (max-width: 1000px) { .svc-grid { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 700px) { .svc-grid { grid-template-columns: 1fr; } }
  .svc {
    background: var(--card);
    padding: 14px;
    display: grid; gap: 4px;
  }
  .svc-head {
    display: flex; align-items: center; gap: 8px;
    font-size: 13px; font-weight: 600;
  }
  .svc-head .dot { width: 9px; height: 9px; }
  .svc-meta { color: var(--muted); font-size: 11.5px; font-variant-numeric: tabular-nums; }
  .svc-line { font-size: 11.5px; color: var(--ink-2); }
  .svc-line code {
    background: var(--bg-c); padding: 0 4px; border-radius: 3px;
    font-size: 11px; color: var(--ink);
  }

  /* ---------- Logs ---------- */
  .logs {
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 11.5px;
    background: var(--bg-c);
    border-radius: 8px;
    padding: 10px 12px;
    height: 380px;
    overflow: auto;
    white-space: pre;
    line-height: 1.55;
  }
  [data-theme='dark'] .logs { background: #0a0b0e; }
  .logs .l-time { color: var(--muted); }
  .logs .l-err { color: var(--danger); }
  .logs .l-warn { color: var(--warn); }
  .logs .l-ok { color: var(--ok); }
  .logs .l-info { color: var(--info); }
  .logs .l-tag { color: var(--brand); }

  /* ---------- QR placeholder ---------- */
  .qr {
    width: 120px; height: 120px;
    background: var(--bg-a);
    border-radius: 6px;
    border: 1px solid var(--line);
    overflow: hidden;
  }
  .qr img { width: 100%; height: 100%; object-fit: contain; }

  /* ---------- Spec page ---------- */
  .spec-block {
    border-left: 2px solid var(--brand);
    padding: 4px 0 4px 14px;
    margin: 12px 0;
  }
  .spec-block h4 {
    margin: 0 0 4px 0;
    font-size: 13px; font-weight: 700;
    color: var(--ink);
    letter-spacing: -0.01em;
  }
  .spec-block p { margin: 0; font-size: 12.5px; color: var(--ink-2); line-height: 1.5; }
  .spec-block code {
    background: var(--bg-c); padding: 1px 5px; border-radius: 3px; font-size: 11.5px;
  }
  .spec-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 4px; }
  .spec-list li {
    font-size: 12.5px;
    color: var(--ink-2);
    padding-left: 16px;
    position: relative;
    line-height: 1.5;
  }
  .spec-list li::before { content: "—"; position: absolute; left: 0; color: var(--muted); }

  /* ---------- Misc ---------- */
  .screen { display: none; }
  .screen.active { display: grid; gap: 12px; }
  .pill {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 2px 7px;
    border-radius: 999px;
    background: var(--bg-c);
    color: var(--muted);
    font-size: 11px; font-weight: 500;
  }
  .pill.brand { background: var(--brand-light); color: var(--brand); }
  .ico { width: 14px; height: 14px; flex-shrink: 0; }

  .review-list::-webkit-scrollbar,
  .logs::-webkit-scrollbar,
  .table-wrap::-webkit-scrollbar { width: 8px; height: 8px; }
  .review-list::-webkit-scrollbar-thumb,
  .logs::-webkit-scrollbar-thumb,
  .table-wrap::-webkit-scrollbar-thumb { background: var(--line); border-radius: 4px; }

  /* ── Offer-History · Kalenderwochen-Explorer ── */
  .kw-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 8px;
  }
  .kw-card {
    text-align: left;
    border: 1px solid var(--line);
    background: var(--card);
    border-radius: 10px;
    padding: 10px 12px;
    cursor: pointer;
    transition: border-color .12s, background .12s, box-shadow .12s;
    display: flex; flex-direction: column; gap: 6px;
    font: inherit; color: inherit;
  }
  .kw-card:hover { border-color: var(--brand); background: var(--bg-b); }
  .kw-card.active {
    border-color: var(--brand);
    background: var(--brand-light);
    box-shadow: 0 0 0 1px var(--brand) inset;
  }
  .kw-card-top { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
  .kw-num { font-size: 15px; font-weight: 700; color: var(--ink); }
  .kw-year { font-size: 11px; color: var(--muted); }
  .kw-range { font-size: 11px; color: var(--muted); }
  .kw-stats { display: flex; gap: 10px; flex-wrap: wrap; font-size: 11px; color: var(--ink-2); }
  .kw-stats span { display: inline-flex; align-items: center; gap: 3px; }
  .kw-stats svg { opacity: .7; }

  .kw-detail { margin-top: 14px; }
  .kw-detail-hint { margin-top: 0; }
  .kw-detail-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .kw-detail-head h4 { font-size: 13px; font-weight: 700; color: var(--ink); margin: 0; }
  .kw-detail-stats { display: flex; flex-wrap: wrap; gap: 14px; margin-bottom: 10px; }
  .kw-stat { display: flex; flex-direction: column; }
  .kw-stat-v { font-size: 16px; font-weight: 700; color: var(--ink); line-height: 1.1; }
  .kw-stat-l { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .kw-limit-note { font-size: 11px; color: var(--warn); margin-bottom: 8px; }

  .kw-filter-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
  .kw-search {
    flex: 1 1 220px; min-width: 180px;
    border: 1px solid var(--line); background: var(--bg-a); color: var(--ink);
    border-radius: 8px; padding: 7px 10px; font: inherit; font-size: 12px;
  }
  .kw-search:focus { outline: none; border-color: var(--brand); }
  .kw-toggles { display: flex; gap: 6px; flex-wrap: wrap; }
  .kw-store-filter { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }

  .kw-thumb {
    width: 34px; height: 34px; border-radius: 6px; object-fit: cover;
    background: var(--bg-c); display: inline-block; vertical-align: middle;
  }
  .kw-thumb-empty { display: inline-flex; align-items: center; justify-content: center; color: var(--muted-2); }
  .kw-brand { display: block; font-size: 10px; font-weight: 500; color: var(--muted); }
  .kw-orig { font-size: 11px; color: var(--muted); text-decoration: line-through; }
  .kw-disc { font-size: 11px; font-weight: 600; color: var(--ok); }
`;
