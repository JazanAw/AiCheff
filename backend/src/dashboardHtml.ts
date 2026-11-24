export function renderDashboardHtml(frontendUrl: string): string {
  return `<!doctype html>
<html lang="de">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Cheffity Backend</title>
    <style>
      :root {
        --bg-a: #FFFFFF;
        --bg-b: #F8FAFC;
        --bg-c: #F1F5F9;
        --card: #FFFFFFF2;
        --line: #E5E7EB;
        --line-soft: #F3F4F6;
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
        --neutral-bar: #E5E7EB;
      }
      [data-theme='dark'] {
        --bg-a: #0F0F11;
        --bg-b: #16171A;
        --bg-c: #1B1C20;
        --card: #1E1F23E8;
        --line: #2D2E33;
        --line-soft: #222328;
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
        --neutral-bar: #2D2E33;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        color: var(--ink);
        background:
          radial-gradient(circle at 8% 0%, rgba(255, 107, 53, 0.10), transparent 38%),
          radial-gradient(circle at 92% 0%, rgba(16, 185, 129, 0.06), transparent 32%),
          linear-gradient(180deg, var(--bg-a), var(--bg-b));
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
        -webkit-font-smoothing: antialiased;
        letter-spacing: -0.01em;
      }
      main {
        max-width: 1600px;
        margin: 0 auto;
        padding: 16px;
        display: grid;
        gap: 12px;
      }
      .card {
        border: 1px solid var(--line);
        border-radius: 16px;
        background: var(--card);
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
      }
      [data-theme='dark'] .card { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3); }
      .header {
        padding: 14px 16px;
        display: grid;
        gap: 8px;
      }
      .row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        justify-content: space-between;
      }
      .row-left { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      .brand-row { gap: 12px; align-items: center; }
      .brand-mark {
        width: 36px;
        height: 36px;
        border-radius: 10px;
        background: var(--brand);
        color: #fff;
        display: grid;
        place-items: center;
        font-weight: 700;
        font-size: 1rem;
        flex-shrink: 0;
      }
      h1 {
        margin: 0;
        font-size: 1.25rem;
        font-weight: 700;
        letter-spacing: -0.02em;
      }
      .sub { margin: 2px 0 0; color: var(--muted); font-size: 0.84rem; }
      button, input, select {
        border: 1px solid var(--line);
        border-radius: 10px;
        background: var(--bg-a);
        color: var(--ink);
        font: inherit;
        padding: 8px 12px;
        transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
      }
      [data-theme='dark'] button,
      [data-theme='dark'] input,
      [data-theme='dark'] select { background: var(--bg-b); }
      input:focus, select:focus {
        outline: none;
        border-color: var(--brand);
        box-shadow: 0 0 0 3px var(--brand-light);
      }
      .model-combo { position: relative; display: inline-flex; align-items: center; }
      .model-combo > input { padding-right: 28px; min-width: 220px; }
      .model-combo-arrow {
        position: absolute;
        right: 9px;
        width: 14px;
        height: 14px;
        color: var(--muted);
        pointer-events: none;
      }
      button { cursor: pointer; font-weight: 500; }
      button:hover { border-color: var(--ink); }
      button.primary {
        background: var(--brand);
        color: #fff;
        border-color: transparent;
        font-weight: 600;
      }
      button.primary:hover { background: var(--brand-dark); border-color: transparent; }
      button.danger {
        background: var(--danger);
        color: #fff;
        border-color: transparent;
        font-weight: 600;
      }
      button.danger:hover { background: #DC2626; border-color: transparent; }
      .status {
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 8px 12px;
        background: var(--bg-a);
        color: var(--muted);
        font-size: 0.84rem;
      }
      [data-theme='dark'] .status { background: var(--bg-b); }
      .status[data-kind='ok'] {
        color: var(--ok);
        background: var(--ok-light);
        border-color: transparent;
      }
      .status[data-kind='warn'] {
        color: var(--warn);
        background: var(--warn-light);
        border-color: transparent;
      }
      .status[data-kind='error'] {
        color: var(--danger);
        background: var(--danger-light);
        border-color: transparent;
      }
      .workspace {
        min-height: 680px;
        height: calc(100vh - 210px);
        border: 1px solid var(--line);
        border-radius: 16px;
        overflow: hidden;
        background: var(--card);
        display: grid;
        grid-template-columns: minmax(320px, 1fr) minmax(320px, 1fr);
        grid-template-rows: minmax(280px, 1fr) minmax(260px, 1fr);
      }
      .slot { padding: 10px; overflow: hidden; }
      .slot[data-slot='top-left'] { grid-column: 1; grid-row: 1; }
      .slot[data-slot='top-right'] { grid-column: 2; grid-row: 1; }
      .slot[data-slot='bottom-full'] { grid-column: 1 / span 2; grid-row: 2; }
      .module {
        border: 1px solid var(--line);
        border-radius: 12px;
        background: var(--bg-a);
        height: 100%;
        display: grid;
        grid-template-rows: auto 1fr;
      }
      [data-theme='dark'] .module { background: var(--bg-b); }
      .module-head {
        border-bottom: 1px solid var(--line-soft);
        padding: 10px 12px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .module-head h2 { margin: 0; font-size: 0.98rem; font-weight: 600; }
      .module-head small { color: var(--muted); font-size: 0.74rem; }
      .module-body {
        padding: 10px 12px;
        display: grid;
        gap: 8px;
        overflow: auto;
        align-content: start;
      }
      .tight { gap: 6px; }
      .badge {
        border: 1px solid var(--line);
        border-radius: 999px;
        padding: 4px 10px;
        background: var(--card);
        font-size: 0.75rem;
        font-weight: 500;
      }
      .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(225px, 1fr)); gap: 10px; }
      .offer {
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 10px;
        background: var(--card);
        display: grid;
        gap: 6px;
        transition: border-color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease;
      }
      .offer:hover {
        border-color: var(--brand);
        box-shadow: 0 4px 12px rgba(255, 107, 53, 0.08);
      }
      .offer-top { display: grid; grid-template-columns: 58px 1fr; gap: 8px; }
      .img {
        width: 58px;
        height: 58px;
        border-radius: 10px;
        overflow: hidden;
        background: var(--line-soft);
        border: 1px solid var(--line);
        display: grid;
        place-items: center;
        font-size: 0.7rem;
        color: var(--muted);
      }
      .img img { width: 100%; height: 100%; object-fit: contain; padding: 3px; background: #fff; }
      .name, .price, .meta, .tags { margin: 0; }
      .name { font-size: 0.9rem; }
      .price { font-size: 0.92rem; font-weight: 700; }
      .meta, .tags { font-size: 0.75rem; color: var(--muted); }
      .foot { display: flex; justify-content: space-between; gap: 6px; flex-wrap: wrap; align-items: center; }
      .pill { border: 1px solid var(--line); border-radius: 999px; padding: 4px 8px; font-size: 0.74rem; display: inline-flex; gap: 5px; align-items: center; }
      .link { color: var(--brand); font-size: 0.75rem; text-decoration: none; }
      .link:hover { text-decoration: underline; }
      .box { border: 1px solid var(--line); border-radius: 12px; padding: 10px; background: var(--card); display: grid; gap: 8px; }
      .box h3 { margin: 0; font-size: 0.88rem; font-weight: 600; }
      .monitor-qr {
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 10px;
        background: var(--card);
        display: grid;
        gap: 6px;
      }
      .monitor-qr img {
        width: 220px;
        height: 220px;
        border: 1px solid var(--line);
        border-radius: 10px;
        background: #fff;
      }
      .warns { border: 1px solid var(--line); border-radius: 12px; padding: 8px 10px; background: var(--warn-light); display: grid; gap: 5px; }
      .warn { color: var(--warn); font-size: 0.8rem; }
      .empty { color: var(--muted); font-style: italic; font-size: 0.84rem; }
      .keywords { display: flex; flex-wrap: wrap; gap: 6px; max-height: 120px; overflow: auto; }
      .keyword { border: 1px solid var(--line); border-radius: 999px; padding: 4px 7px; display: inline-flex; gap: 5px; align-items: center; font-size: 0.73rem; }
      .keyword button { padding: 2px 6px; font-size: 0.7rem; }
      pre {
        margin: 0;
        border: 1px solid var(--line);
        border-radius: 12px;
        background: #0F0F11;
        color: #E5E7EB;
        padding: 12px;
        max-height: 280px;
        overflow: auto;
        font-size: 0.76rem;
        line-height: 1.5;
        font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
      }
      @media (max-width: 1180px) {
        .workspace { height: auto; min-height: 0; grid-template-columns: 1fr; grid-template-rows: auto; }
        .slot { grid-column: 1 !important; grid-row: auto !important; min-height: 300px; }
      }

      /* Datenqualitaet */
      .quality-section { overflow: hidden; }
      .quality-head {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 16px;
        border-bottom: 1px solid var(--line-soft);
        flex-wrap: wrap;
      }
      .quality-section h2 { margin: 0; font-size: 0.98rem; font-weight: 650; letter-spacing: -0.01em; }
      .quality-section h3 {
        margin: 0;
        font-size: 0.78rem;
        font-weight: 650;
        color: var(--ink);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .quality-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-left: auto; }
      .quality-actions button { border-radius: 8px; padding: 6px 10px; font-size: 0.82rem; display: inline-flex; align-items: center; gap: 6px; }
      .quality-actions svg { width: 14px; height: 14px; flex-shrink: 0; }
      .quality-kpis {
        display: grid;
        grid-template-columns: repeat(7, minmax(0, 1fr));
        gap: 1px;
        background: var(--line-soft);
        border-bottom: 1px solid var(--line-soft);
      }
      @media (max-width: 1200px) { .quality-kpis { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
      @media (max-width: 720px) { .quality-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
      .kpi {
        background: var(--card);
        padding: 12px 14px;
        display: grid;
        gap: 4px;
        min-width: 0;
      }
      .kpi-label {
        font-size: 0.68rem;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        font-weight: 650;
        display: flex;
        align-items: center;
        gap: 6px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .kpi-value-row { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
      .kpi-value {
        font-size: 1.45rem;
        font-weight: 750;
        letter-spacing: -0.02em;
        color: var(--ink);
        font-variant-numeric: tabular-nums;
      }
      .kpi-unit { color: var(--muted); font-size: 0.8rem; font-weight: 500; }
      .kpi-sub { font-size: 0.7rem; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .quality-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--muted-2);
        flex-shrink: 0;
      }
      .quality-dot.ok { background: var(--ok); }
      .quality-dot.warn { background: var(--warn); }
      .quality-dot.crit { background: var(--danger); }
      .quality-minibar {
        height: 3px;
        border-radius: 2px;
        background: var(--neutral-bar);
        overflow: hidden;
        margin-top: 2px;
      }
      .quality-minibar > span {
        display: block;
        height: 100%;
        background: var(--muted-2);
        border-radius: 2px;
      }
      .quality-minibar.ok > span { background: var(--ok); }
      .quality-minibar.warn > span { background: var(--warn); }
      .quality-minibar.crit > span { background: var(--danger); }
      .quality-body {
        display: grid;
        grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr);
      }
      .quality-panel { padding: 14px 16px; min-width: 0; }
      .quality-panel + .quality-panel { border-left: 1px solid var(--line-soft); }
      .quality-panel-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        margin-bottom: 10px;
        gap: 8px;
        flex-wrap: wrap;
      }
      .quality-panel-meta { color: var(--muted); font-size: 0.74rem; }
      .quality-table-wrap {
        overflow: auto;
        border: 1px solid var(--line-soft);
        border-radius: 8px;
        max-height: 520px;
      }
      .quality-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.76rem;
        font-variant-numeric: tabular-nums;
      }
      .quality-table th, .quality-table td {
        padding: 9px 10px;
        text-align: right;
        border-bottom: 1px solid var(--line-soft);
        white-space: nowrap;
        vertical-align: middle;
      }
      .quality-table th {
        background: var(--bg-c);
        position: sticky;
        top: 0;
        font-weight: 650;
        color: var(--muted);
        z-index: 1;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-size: 0.66rem;
      }
      .quality-table th:first-child, .quality-table td:first-child { text-align: left; }
      .quality-table tbody tr:hover td { background: var(--bg-b); }
      .quality-table td.store-name {
        font-weight: 650;
        color: var(--ink);
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .store-logo {
        width: 22px;
        height: 22px;
        border-radius: 5px;
        display: grid;
        place-items: center;
        font-size: 0.66rem;
        font-weight: 750;
        color: #fff;
        background: var(--brand);
        flex-shrink: 0;
      }
      .low-pill {
        display: inline-flex;
        align-items: center;
        padding: 1px 6px;
        border-radius: 999px;
        background: var(--warn-light);
        color: var(--warn);
        font-size: 0.65rem;
        font-weight: 700;
        margin-left: 4px;
      }
      tr.low-store td:first-child { box-shadow: inset 3px 0 0 var(--warn); }
      .pct-cell {
        display: inline-flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 3px;
        min-width: 56px;
      }
      .pct-val { font-weight: 600; line-height: 1; color: var(--muted); }
      .pct-bar {
        width: 48px;
        height: 3px;
        background: var(--neutral-bar);
        border-radius: 2px;
        overflow: hidden;
      }
      .pct-bar > span { display: block; height: 100%; background: var(--muted-2); border-radius: 2px; }
      .pct-cell.ok .pct-val { color: var(--ok); }
      .pct-cell.ok .pct-bar > span { background: var(--ok); }
      .pct-cell.warn .pct-val { color: var(--warn); }
      .pct-cell.warn .pct-bar > span { background: var(--warn); }
      .pct-cell.crit .pct-val { color: var(--danger); }
      .pct-cell.crit .pct-bar > span { background: var(--danger); }
      .status-badge {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 3px 8px;
        border-radius: 999px;
        font-size: 0.68rem;
        font-weight: 700;
        white-space: nowrap;
      }
      .status-badge.ok { background: var(--ok-light); color: var(--ok); }
      .status-badge.warn { background: var(--warn-light); color: var(--warn); }
      .status-badge.crit { background: var(--danger-light); color: var(--danger); }
      .status-badge.neutral { background: var(--bg-c); color: var(--muted); }
      .review-filter { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
      .review-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: var(--bg-a);
        color: var(--ink-2);
        font-size: 0.72rem;
        font-weight: 600;
        cursor: pointer;
      }
      [data-theme='dark'] .review-chip { background: var(--bg-c); }
      .review-chip:hover { border-color: var(--muted); }
      .review-chip.active { background: var(--ink); color: var(--bg-a); border-color: var(--ink); }
      .review-chip-count { color: var(--muted); font-weight: 750; font-variant-numeric: tabular-nums; }
      .review-chip.active .review-chip-count { color: var(--bg-a); opacity: 0.75; }
      .review-list { display: grid; gap: 6px; max-height: 470px; overflow: auto; padding-right: 4px; }
      .review-item {
        border: 1px solid var(--line-soft);
        border-radius: 8px;
        padding: 9px 10px;
        background: var(--bg-a);
        display: grid;
        gap: 5px;
      }
      [data-theme='dark'] .review-item { background: var(--bg-c); }
      .review-item:hover { border-color: var(--line); }
      .review-head { display: flex; gap: 10px; justify-content: space-between; align-items: baseline; flex-wrap: wrap; }
      .review-name { font-weight: 650; font-size: 0.82rem; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; }
      .review-meta { font-size: 0.72rem; color: var(--muted); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; font-variant-numeric: tabular-nums; }
      .dotmini { width: 3px; height: 3px; border-radius: 50%; background: var(--muted-2); }
      .review-tags { display: flex; flex-wrap: wrap; gap: 4px; }
      .review-tag { font-size: 0.66rem; padding: 2px 7px; border-radius: 999px; background: var(--danger-light); color: var(--danger); border: 1px solid transparent; font-weight: 650; }
      .review-tag.warn { background: var(--warn-light); color: var(--warn); }
      .review-foot { display: flex; justify-content: flex-end; font-size: 0.7rem; }
      .review-foot a { color: var(--brand); text-decoration: none; font-weight: 650; }
      .review-foot a:hover { text-decoration: underline; }
      @media (max-width: 1100px) {
        .quality-body { grid-template-columns: 1fr; }
        .quality-panel + .quality-panel { border-left: none; border-top: 1px solid var(--line-soft); }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="card header">
        <div class="row">
          <div class="row-left brand-row">
            <div class="brand-mark">C</div>
            <div>
              <h1>Cheffity Backend</h1>
              <p class="sub">Ein Fenster, 3 klare Bereiche: Live, Filtered und Monitor.</p>
            </div>
          </div>
          <div class="row-left">
            <button id="theme-toggle">Dark Mode</button>
            <button class="primary" data-action="one-click-ai-live">Alles neu + KI + App Start</button>
            <button class="primary" data-action="start-app">Frontend starten</button>
            <button class="primary" data-action="start-mobile">Mobile starten</button>
            <button class="primary" data-action="mobile-refresh">Mobile Refresh (r)</button>
            <button data-action="stop-mobile">Mobile stoppen</button>
            <button class="primary" data-action="open-app-link">App Oeffnen</button>
            <button data-action="refresh-all">Alles neu laden</button>
            <button class="primary" data-action="open-rewe-screenshot-import">REWE Screenshot/PDF</button>
          </div>
        </div>
        <div class="row-left">
          <span class="model-combo">
            <input id="ollama-model" type="text" list="ollama-model-options" autocomplete="off" placeholder="qwen3:14b" title="Installiertes Modell waehlen oder eigenes eintragen" />
            <svg class="model-combo-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
            <datalist id="ollama-model-options"></datalist>
          </span>
          <button class="primary" data-action="ollama-pull-model">Modell laden</button>
          <button data-action="ollama-pull-status">Pull Status</button>
        </div>
        <div id="dash-status" class="status" data-kind="info">Dashboard wird geladen...</div>
      </section>

      <section id="workspace" class="workspace">
        <div class="slot" data-slot="top-left">
          <section class="module" id="module-live" data-module="live">
            <header class="module-head">
              <div>
                <h2>Angebote Live</h2>
                <small>Live zeigt die aktive Angebotswoche. Am Sonntag wird automatisch die naechste Kalenderwoche angezeigt.</small>
              </div>
            </header>
            <div class="module-body">
              <div class="row-left tight">
                <span id="live-meta" class="badge">Lade...</span>
                <button data-action="live-refresh">Neu laden</button>
                <button data-action="download-live-offers">Live herunterladen</button>
                <button id="live-auto-toggle" class="primary" data-action="live-auto">Auto: AN</button>
                <button class="primary" data-action="offers-filter-food-live">Food Filter</button>
                <button class="primary" data-action="ai-rescan-food">KI Neu-Scan</button>
              </div>
              <div class="row-left tight">
                <input id="live-search" type="text" placeholder="Suche Name, Marke, Tags" />
                <select id="live-week-view">
                  <option value="current">Diese Woche</option>
                  <option value="next">Naechste Woche</option>
                </select>
                <select id="live-store"></select>
                <select id="live-category"></select>
                <select id="live-scope">
                  <option value="both">Beides</option>
                  <option value="national">National</option>
                  <option value="local">Lokal</option>
                </select>
                <button class="danger" data-action="move-selected-to-filtered">Auswahl rausfiltern</button>
              </div>
              <div id="live-warnings"></div>
              <div id="live-grid" class="grid"></div>
            </div>
          </section>
        </div>
        <div class="slot" data-slot="top-right">
          <section class="module" id="module-filtered" data-module="filtered">
            <header class="module-head">
              <div>
                <h2>Filtered</h2>
                <small>Rausgefilterte Angebote und Rueckfuehrung zu Live. Listen: Beides, National, Lokal.</small>
              </div>
            </header>
            <div class="module-body">
              <div class="row-left tight">
                <span id="filtered-meta" class="badge">0 Treffer</span>
                <button data-action="filtered-refresh">Neu laden</button>
                <button data-action="download-filtered-offers">Filtered herunterladen</button>
                <button class="primary" data-action="move-selected-to-live">Auswahl zu Live</button>
              </div>
              <div class="row-left tight">
                <input id="filtered-search" type="text" placeholder="Suche Name, Marke, Tags" />
                <select id="filtered-store"></select>
                <select id="filtered-category"></select>
                <select id="filtered-scope">
                  <option value="both">Beides</option>
                  <option value="national">National</option>
                  <option value="local">Lokal</option>
                </select>
              </div>
              <div id="filtered-grid" class="grid"></div>
            </div>
          </section>
        </div>

        <div class="slot" data-slot="bottom-full">
          <section class="module" id="module-monitor" data-module="monitor">
            <header class="module-head">
              <div>
                <h2>Monitor</h2>
                <small>Ingest, Prozesse, Warnungen und Debug-Logs.</small>
              </div>
            </header>
            <div class="module-body">
              <section class="box">
                <h3>Status</h3>
                <div id="monitor-ingest" class="sub">Ingest: -</div>
                <div id="monitor-one-click" class="sub">One-Click-KI: -</div>
                <div id="monitor-rescan" class="sub">KI-Rescan: -</div>
                <div id="monitor-system" class="sub">System: -</div>
                <div id="monitor-pull" class="sub">Ollama Pull: -</div>
                <div id="monitor-local-sources" class="sub">Lokale Quellen: -</div>
                <div id="monitor-mobile-qr" class="monitor-qr">
                  <p class="empty">QR verfuegbar sobald Mobile gestartet ist.</p>
                </div>
              </section>
              <section class="box">
                <div class="row">
                  <h3>Warnings</h3>
                  <button data-action="debug-load-logs">Logs laden</button>
                </div>
                <div id="monitor-warnings"></div>
              </section>
              <section class="box">
                <div class="row">
                  <h3>Debug Logs</h3>
                  <button data-action="debug-clear">Logs leeren</button>
                </div>
                <pre id="monitor-logs">Noch keine Logs geladen.</pre>
              </section>
            </div>
          </section>
        </div>
      </section>

      <section class="card quality-section" id="quality-section">
        <div class="quality-head">
          <div>
            <h2>Datenqualität</h2>
            <p class="sub" id="quality-updated">Snapshot wird ausgewertet…</p>
          </div>
          <div class="quality-actions">
            <button data-action="quality-download">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              JSON
            </button>
            <button class="primary" data-action="quality-refresh">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
              Neu berechnen
            </button>
          </div>
        </div>
        <div class="quality-kpis" id="quality-kpis"></div>
        <div class="quality-body">
          <div class="quality-panel">
            <div class="quality-panel-head">
              <h3>Pro Supermarkt</h3>
              <span class="quality-panel-meta" id="quality-store-meta">sortiert nach Kritikalität</span>
            </div>
            <div class="quality-table-wrap">
              <table class="quality-table" id="quality-stores">
                <thead>
                  <tr>
                    <th>Store</th>
                    <th>Angebote</th>
                    <th title="Angebote mit Produktbild">Bild</th>
                    <th title="Angebote mit gültigem aktuellem Angebotspreis (App-Blocker, wenn niedrig)">Akt. Preis</th>
                    <th title="Angebote mit UVP/Streichpreis — Anreicherung, kein Blocker">Streichpreis</th>
                    <th title="Angebote mit berechnetem Rabatt — Anreicherung, kein Blocker">Rabatt</th>
                    <th title="Nährwerte — Anreicherung offen, kein Scraper-Fehler">Nutrition</th>
                    <th title="Allergene — Anreicherung offen, kein Scraper-Fehler">Allergene</th>
                    <th title="Halal yes/no klassifiziert — Anreicherung offen">Halal</th>
                    <th title="Angebote mit echter Kategorie (nicht other/Sonstiges)">Kategorie</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody></tbody>
              </table>
            </div>
          </div>
          <div class="quality-panel">
            <div class="quality-panel-head">
              <h3>Braucht Review</h3>
              <span class="quality-panel-meta" id="quality-review-title">wird geladen</span>
            </div>
            <div class="review-filter" id="quality-review-filter"></div>
            <div class="review-list" id="quality-review"></div>
          </div>
        </div>
      </section>
    </main>

    <script>
      (() => {
        const FRONTEND_URL = ${JSON.stringify(frontendUrl)};
        const THEME_KEY = 'aichef.backend.theme';
        const AUTO_KEY = 'aichef.backend.auto';

        const state = {
          offers: [],
          nextWeekOffers: [],
          filteredOffers: [],
          offerScopes: {},
          scopeSummary: null,
          localSources: [],
          warnings: [],
          updatedAt: null,
          ingest: null,
          oneClickAi: null,
          aiRescan: null,
          system: null,
          ollamaPull: null,
          logs: [],
          quality: null,
          qualityReviewFilter: 'all',
          liveSelected: new Set(),
          filteredSelected: new Set(),
          auto: true,
          autoTimer: null,
        };

        const byId = (id) => document.getElementById(id);

        const esc = (value) =>
          String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');

        const norm = (value) => String(value ?? '').toLowerCase().trim();

        function normalizeScopeFlags(scope) {
          const national = !!(scope && scope.national === true);
          const local = !!(scope && scope.local === true);
          if (!national && !local) {
            return { national: true, local: true };
          }
          return { national, local };
        }

        function normalizeOfferScopes(rawMap) {
          if (!rawMap || typeof rawMap !== 'object') {
            return {};
          }
          const next = {};
          Object.entries(rawMap).forEach(([offerId, scope]) => {
            if (!offerId) {
              return;
            }
            next[offerId] = normalizeScopeFlags(scope);
          });
          return next;
        }

        function offerScopeFor(offerId) {
          if (!offerId) {
            return { national: true, local: true };
          }
          const scope = state.offerScopes[offerId];
          return normalizeScopeFlags(scope);
        }

        function matchesScope(offerId, scopeMode) {
          if (!scopeMode || scopeMode === 'both') {
            return true;
          }
          const scope = offerScopeFor(offerId);
          if (scopeMode === 'national') {
            return scope.national;
          }
          if (scopeMode === 'local') {
            return scope.local;
          }
          return true;
        }

        function scopeLabel(scopeMode) {
          if (scopeMode === 'national') {
            return 'National';
          }
          if (scopeMode === 'local') {
            return 'Lokal';
          }
          return 'Beides';
        }

        function getLiveWeekView() {
          const mode = norm(byId('live-week-view')?.value || 'current');
          return mode === 'next' ? 'next' : 'current';
        }

        function isSundayRolloverDay() {
          return new Date().getDay() === 0;
        }

        function getActiveLiveOffers() {
          return getLiveWeekView() === 'next' ? state.nextWeekOffers : state.offers;
        }

        function liveWeekLabel() {
          if (getLiveWeekView() === 'next') {
            return isSundayRolloverDay() ? 'Uebernaechste Woche' : 'Naechste Woche';
          }
          return isSundayRolloverDay() ? 'Naechste Kalenderwoche' : 'Diese Woche';
        }

        function updateLiveWeekOptionLabels() {
          const select = byId('live-week-view');
          if (!select) {
            return;
          }
          const current = select.querySelector('option[value="current"]');
          const next = select.querySelector('option[value="next"]');
          if (current) {
            current.textContent = isSundayRolloverDay() ? 'Naechste Kalenderwoche' : 'Diese Woche';
          }
          if (next) {
            next.textContent = isSundayRolloverDay() ? 'Uebernaechste Woche' : 'Naechste Woche';
          }
        }

        function status(message, kind) {
          const node = byId('dash-status');
          if (!node) {
            return;
          }
          node.textContent = message;
          node.dataset.kind = kind || 'info';
        }

        function normalizeClientErrorMessage(value) {
          if (value instanceof Error) {
            return value.message;
          }
          if (typeof value === 'string') {
            return value;
          }
          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        }

        function reportClientError(payload) {
          fetch('/api/debug/client-error', {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload || {}),
          }).catch(() => {});
        }

        function reportUnknownClientError(error, type, extra) {
          const base = {
            type: type || 'error',
            message: normalizeClientErrorMessage(error),
            stack: error instanceof Error ? error.stack : undefined,
            userAgent: navigator.userAgent,
            href: window.location.href,
          };
          reportClientError(Object.assign(base, extra || {}));
        }

        window.addEventListener('error', (event) => {
          reportClientError({
            type: 'error',
            message: event.message || 'Unbekannter Browser-Fehler',
            source: event.filename || undefined,
            line: typeof event.lineno === 'number' ? event.lineno : undefined,
            column: typeof event.colno === 'number' ? event.colno : undefined,
            stack: event.error instanceof Error ? event.error.stack : undefined,
            userAgent: navigator.userAgent,
            href: window.location.href,
          });
        });

        window.addEventListener('unhandledrejection', (event) => {
          reportUnknownClientError(event.reason, 'unhandledrejection');
        });

        function fmtDate(value) {
          if (!value) {
            return '-';
          }
          const date = new Date(value);
          if (Number.isNaN(date.getTime())) {
            return String(value);
          }
          return date.toLocaleString();
        }

        function fmtPrice(offer) {
          const num = Number(offer.price);
          const amount = Number.isFinite(num) ? num.toFixed(2).replace('.', ',') : String(offer.price || '-');
          return amount + ' ' + (offer.currency || 'EUR') + (offer.unit ? ' / ' + offer.unit : '');
        }

        function readJson(key) {
          try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : null;
          } catch {
            return null;
          }
        }

        function setTheme(theme) {
          const next = theme === 'dark' ? 'dark' : 'light';
          document.documentElement.setAttribute('data-theme', next);
          localStorage.setItem(THEME_KEY, next);
          const toggle = byId('theme-toggle');
          if (toggle) {
            toggle.textContent = next === 'dark' ? 'Light Mode' : 'Dark Mode';
          }
        }

        function updateAutoToggle() {
          const button = byId('live-auto-toggle');
          if (!button) {
            return;
          }
          if (state.auto) {
            button.textContent = 'Auto: AN';
            button.classList.add('primary');
          } else {
            button.textContent = 'Auto: AUS';
            button.classList.remove('primary');
          }
        }

        function configureAuto() {
          if (state.autoTimer) {
            window.clearInterval(state.autoTimer);
            state.autoTimer = null;
          }
          updateAutoToggle();
          if (!state.auto) {
            return;
          }
          state.autoTimer = window.setInterval(() => {
            refresh(false, true).catch(() => {});
          }, 25000);
        }

        async function api(path, method, body) {
          const response = await fetch(path, {
            method: method || 'GET',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
            },
            body: method && method !== 'GET' ? JSON.stringify(body || {}) : undefined,
          });
          const text = await response.text();
          let data = {};
          if (text) {
            try {
              data = JSON.parse(text);
            } catch {
              data = {};
            }
          }
          if (!response.ok) {
            const msg = data && typeof data === 'object' && 'error' in data ? String(data.error) : 'HTTP ' + response.status;
            throw new Error(msg);
          }
          return data;
        }

        function parseDownloadFilename(contentDisposition) {
          const raw = String(contentDisposition || '');
          const utf8Match = raw.match(/filename\\*=UTF-8''([^;]+)/i);
          if (utf8Match && utf8Match[1]) {
            try {
              return decodeURIComponent(utf8Match[1]);
            } catch {
              return utf8Match[1];
            }
          }

          const plainMatch = raw.match(/filename="?([^"]+)"?/i);
          return plainMatch && plainMatch[1] ? plainMatch[1] : null;
        }

        async function downloadFromApi(path, fallbackFileName) {
          const response = await fetch(path, {
            method: 'GET',
            headers: {
              Accept: '*/*',
            },
          });

          if (!response.ok) {
            const text = await response.text();
            let errorMessage = 'Download fehlgeschlagen (HTTP ' + response.status + ').';
            if (text) {
              try {
                const parsed = JSON.parse(text);
                if (parsed && typeof parsed.error === 'string') {
                  errorMessage = parsed.error;
                }
              } catch {
                // no-op
              }
            }
            throw new Error(errorMessage);
          }

          const blob = await response.blob();
          const disposition = response.headers.get('content-disposition') || '';
          const fileName = parseDownloadFilename(disposition) || fallbackFileName;
          const objectUrl = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = objectUrl;
          link.download = fileName;
          document.body.appendChild(link);
          link.click();
          link.remove();
          URL.revokeObjectURL(objectUrl);
        }

        function mergeOffers(payload) {
          if (Array.isArray(payload.offers)) {
            state.offers = payload.offers;
          }
          if (Array.isArray(payload.nextWeekOffers)) {
            state.nextWeekOffers = payload.nextWeekOffers;
          }
          if (Array.isArray(payload.filteredOffers)) {
            state.filteredOffers = payload.filteredOffers;
          }
          if (payload.offerScopes && typeof payload.offerScopes === 'object') {
            state.offerScopes = normalizeOfferScopes(payload.offerScopes);
          }
          if (payload.scopeSummary && typeof payload.scopeSummary === 'object') {
            state.scopeSummary = payload.scopeSummary;
          }
          if (Array.isArray(payload.localSources)) {
            state.localSources = payload.localSources;
          }
          if (Array.isArray(payload.warnings)) {
            state.warnings = payload.warnings;
          }
          if (Object.prototype.hasOwnProperty.call(payload, 'updatedAt')) {
            state.updatedAt = payload.updatedAt;
          }
          if (payload.ingest) {
            state.ingest = payload.ingest;
          }
          if (payload.oneClickAi) {
            state.oneClickAi = payload.oneClickAi;
          }
          if (payload.aiRescan) {
            state.aiRescan = payload.aiRescan;
          }
          if (payload.system) {
            state.system = payload.system;
          }
          if (payload.ollamaPull) {
            state.ollamaPull = payload.ollamaPull;
          }
        }

        function mergeSystem(payload) {
          if (payload.oneClickAi) {
            state.oneClickAi = payload.oneClickAi;
          }
          if (payload.aiRescan) {
            state.aiRescan = payload.aiRescan;
          }
          if (payload.system) {
            state.system = payload.system;
          }
          if (payload.ollamaPull) {
            state.ollamaPull = payload.ollamaPull;
          }
        }

        function cleanupSelections() {
          const liveIds = new Set([
            ...state.offers.map((offer) => offer.id),
            ...state.nextWeekOffers.map((offer) => offer.id),
          ]);
          const filteredIds = new Set(state.filteredOffers.map((offer) => offer.id));
          [...state.liveSelected].forEach((id) => {
            if (!liveIds.has(id)) {
              state.liveSelected.delete(id);
            }
          });
          [...state.filteredSelected].forEach((id) => {
            if (!filteredIds.has(id)) {
              state.filteredSelected.delete(id);
            }
          });
        }

        function fillSelect(id, values, placeholder) {
          const select = byId(id);
          if (!select) {
            return;
          }
          const before = select.value || '';
          const unique = Array.from(new Set(values.filter(Boolean))).sort((a, b) => String(a).localeCompare(String(b), 'de'));
          select.innerHTML = ['<option value="">' + esc(placeholder) + '</option>']
            .concat(unique.map((entry) => '<option value="' + esc(entry) + '">' + esc(entry) + '</option>'))
            .join('');
          if (before && unique.includes(before)) {
            select.value = before;
          }
        }

        function refreshFilterControls() {
          const activeLive = getActiveLiveOffers();
          fillSelect('live-store', activeLive.map((offer) => offer.storeChain || ''), 'Alle Maerkte');
          fillSelect('live-category', activeLive.map((offer) => offer.category || ''), 'Alle Kategorien');
          fillSelect('filtered-store', state.filteredOffers.map((offer) => offer.storeChain || ''), 'Alle Maerkte');
          fillSelect('filtered-category', state.filteredOffers.map((offer) => offer.category || ''), 'Alle Kategorien');
        }

        function filterOffers(offers, config) {
          const q = norm(byId(config.search)?.value || '');
          const store = norm(byId(config.store)?.value || '');
          const category = norm(byId(config.category)?.value || '');
          const scope = norm(byId(config.scope)?.value || 'both');
          return offers.filter((offer) => {
            if (!matchesScope(offer.id, scope)) {
              return false;
            }
            const text = norm((offer.name || '') + ' ' + (offer.brand || '') + ' ' + (offer.category || '') + ' ' + (offer.tags || []).join(' '));
            if (q && !text.includes(q)) {
              return false;
            }
            if (store && !norm(offer.storeChain).includes(store)) {
              return false;
            }
            if (category && !norm(offer.category).includes(category)) {
              return false;
            }
            return true;
          });
        }

        function sortOffers(offers) {
          return [...offers].sort((a, b) => {
            const s = String(a.storeChain || '').localeCompare(String(b.storeChain || ''), 'de');
            if (s !== 0) {
              return s;
            }
            return String(a.name || '').localeCompare(String(b.name || ''), 'de');
          });
        }

        function getVisibleLiveOffers() {
          const activeLive = getActiveLiveOffers();
          return sortOffers(
            filterOffers(activeLive, {
              search: 'live-search',
              store: 'live-store',
              category: 'live-category',
              scope: 'live-scope',
            }),
          );
        }

        function getVisibleFilteredOffers() {
          return sortOffers(
            filterOffers(state.filteredOffers, {
              search: 'filtered-search',
              store: 'filtered-store',
              category: 'filtered-category',
              scope: 'filtered-scope',
            }),
          );
        }

        function normalizeForCopy(value) {
          return String(value ?? '').replace(/[\\r\\n\\t]+/g, ' ').trim();
        }

        function offersToClipboardText(title, offers) {
          const header = [
            'Name',
            'Preis',
            'Markt',
            'Kategorie',
            'GueltigVon',
            'GueltigBis',
            'Bild',
            'Quelle',
            'Tags',
          ].join('\\t');

          const rows = offers.map((offer) =>
            [
              normalizeForCopy(offer.name),
              normalizeForCopy(fmtPrice(offer)),
              normalizeForCopy(offer.storeChain),
              normalizeForCopy(offer.category),
              normalizeForCopy(offer.validityStart),
              normalizeForCopy(offer.validityEnd),
              normalizeForCopy(offer.imageUrl),
              normalizeForCopy(offer.sourceUrl),
              normalizeForCopy(Array.isArray(offer.tags) ? offer.tags.join(', ') : ''),
            ].join('\\t'),
          );

          return [title + ' (' + offers.length + ')', header, ...rows].join('\\n');
        }

        async function copyTextToClipboard(text) {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(text);
            return;
          }

          const area = document.createElement('textarea');
          area.value = text;
          area.setAttribute('readonly', 'readonly');
          area.style.position = 'fixed';
          area.style.opacity = '0';
          area.style.left = '-9999px';
          document.body.appendChild(area);
          area.focus();
          area.select();
          const success = document.execCommand('copy');
          document.body.removeChild(area);
          if (!success) {
            throw new Error('Kopieren fehlgeschlagen.');
          }
        }

        function selectedOffersFrom(baseOffers, selectedIds) {
          if (!selectedIds || selectedIds.size === 0) {
            return [];
          }
          const selectedMap = new Set(selectedIds);
          return baseOffers.filter((offer) => selectedMap.has(offer.id));
        }

        function img(url) {
          if (!url) {
            return '<div class="img">kein bild</div>';
          }
          return '<div class="img"><img src="' + esc(url) + '" loading="lazy" alt="offer" onerror="this.parentNode.textContent=&quot;kein bild&quot;;" /></div>';
        }

        function card(offer, mode) {
          const live = mode === 'live';
          const selected = live ? state.liveSelected.has(offer.id) : state.filteredSelected.has(offer.id);
          const moveAction = live ? 'move-to-filtered' : 'move-to-live';
          const moveLabel = live ? 'Rausfiltern' : 'Zu Live';
          const moveClass = live ? 'danger' : 'primary';
          const toggleAction = live ? 'toggle-live' : 'toggle-filtered';
          const tags = Array.isArray(offer.tags) && offer.tags.length > 0 ? offer.tags.join(', ') : '-';
          const scope = offerScopeFor(offer.id);
          const scopeText = scope.local && !scope.national
            ? 'Lokal'
            : scope.national && !scope.local
              ? 'National'
              : 'Beides';
          const distanceText = Number.isFinite(Number(offer.distanceKm))
            ? ' | ' + Number(offer.distanceKm).toFixed(Number(offer.distanceKm) < 10 ? 1 : 0) + ' km'
            : '';
          return (
            '<article class="offer">' +
            '<div class="offer-top">' +
            img(offer.imageUrl) +
            '<div>' +
            '<p class="name">' + esc(offer.name || '-') + '</p>' +
            '<p class="price">' + esc(fmtPrice(offer)) + '</p>' +
            '<p class="meta">' + esc((offer.storeChain || '-') + ' | ' + (offer.category || '-')) + '</p>' +
            '<p class="tags">' + esc('Tags: ' + tags) + '</p>' +
            '</div>' +
            '</div>' +
            '<div class="foot">' +
            '<label class="pill"><input type="checkbox" data-action="' + toggleAction + '" data-offer-id="' + esc(offer.id) + '"' + (selected ? ' checked' : '') + ' />Auswahl</label>' +
            '<span class="pill">' + esc(scopeText + distanceText) + '</span>' +
            '<button class="' + moveClass + '" data-action="' + moveAction + '" data-offer-id="' + esc(offer.id) + '">' + moveLabel + '</button>' +
            '</div>' +
            '<p class="meta">' + esc('Gueltig: ' + (offer.validityStart || '-') + ' - ' + (offer.validityEnd || '-')) + '</p>' +
            (offer.sourceUrl ? '<a class="link" href="' + esc(offer.sourceUrl) + '" target="_blank" rel="noreferrer">Quelle</a>' : '') +
            '</article>'
          );
        }

        function renderWarnings(targetId, warnings) {
          const target = byId(targetId);
          if (!target) {
            return;
          }
          if (!Array.isArray(warnings) || warnings.length === 0) {
            target.innerHTML = '';
            return;
          }
          target.innerHTML = '<div class="warns">' + warnings.map((w) => '<div class="warn">' + esc(w) + '</div>').join('') + '</div>';
        }
        function renderLive() {
          const activeLive = getActiveLiveOffers();
          const list = getVisibleLiveOffers();
          const scopeMode = norm(byId('live-scope')?.value || 'both');
          const scopeTotal = activeLive.filter((offer) =>
            matchesScope(offer.id, scopeMode),
          ).length;
          const meta = byId('live-meta');
          if (meta) {
            meta.textContent =
              list.length +
              ' / ' +
              scopeTotal +
              ' ' +
              scopeLabel(scopeMode) +
              ' ' +
              liveWeekLabel() +
              ' Live';
          }
          renderWarnings('live-warnings', state.warnings);
          const grid = byId('live-grid');
          if (!grid) {
            return;
          }
          grid.innerHTML =
            list.length > 0
              ? list.map((offer) => card(offer, 'live')).join('')
              : '<p class="empty">Keine Angebote (' + liveWeekLabel() + ') fuer diesen Filter.</p>';
        }

        function renderFiltered() {
          const list = getVisibleFilteredOffers();
          const scopeMode = norm(byId('filtered-scope')?.value || 'both');
          const scopeTotal = state.filteredOffers.filter((offer) =>
            matchesScope(offer.id, scopeMode),
          ).length;
          const meta = byId('filtered-meta');
          if (meta) {
            meta.textContent =
              list.length +
              ' / ' +
              scopeTotal +
              ' ' +
              scopeLabel(scopeMode) +
              ' Filtered';
          }
          const grid = byId('filtered-grid');
          if (!grid) {
            return;
          }
          grid.innerHTML = list.length > 0 ? list.map((offer) => card(offer, 'filtered')).join('') : '<p class="empty">Keine Filtered-Angebote fuer diesen Filter.</p>';
        }

        function processLine(name, processState) {
          if (!processState) {
            return name + ': -';
          }
          const running = processState.running ? 'running' : 'stopped';
          const pid = processState.pid ? ' pid=' + processState.pid : '';
          const error = processState.lastError ? ' error=' + processState.lastError : '';
          return name + ': ' + running + pid + error;
        }

        function renderMonitor() {
          const ingest = byId('monitor-ingest');
          const oneClick = byId('monitor-one-click');
          const rescan = byId('monitor-rescan');
          const system = byId('monitor-system');
          const pull = byId('monitor-pull');
          const localSources = byId('monitor-local-sources');
          const mobileQr = byId('monitor-mobile-qr');
          const warnings = byId('monitor-warnings');
          const logs = byId('monitor-logs');

          if (ingest) {
            ingest.textContent = state.ingest
              ? 'Ingest: ' + (state.ingest.running ? 'running' : 'idle') + ' | ' + (state.ingest.message || '-') + ' | start: ' + fmtDate(state.ingest.startedAt) + ' | ende: ' + fmtDate(state.ingest.finishedAt)
              : 'Ingest: -';
          }
          if (oneClick) {
            if (!state.oneClickAi) {
              oneClick.textContent = 'One-Click-KI: -';
            } else {
              const total = Number(state.oneClickAi.total || 0);
              const processed = Number(state.oneClickAi.processed || 0);
              const details = total > 0 ? processed + '/' + total : String(processed);
              const stage = state.oneClickAi.stage || 'idle';
              const running = state.oneClickAi.running ? 'running' : 'idle';
              const error = state.oneClickAi.lastError
                ? ' | error=' + state.oneClickAi.lastError
                : '';
              oneClick.textContent =
                'One-Click-KI: ' +
                running +
                ' | stage=' +
                stage +
                ' | ' +
                details +
                ' | ' +
                (state.oneClickAi.message || '-') +
                error;
            }
          }
          if (rescan) {
            if (!state.aiRescan) {
              rescan.textContent = 'KI-Rescan: -';
            } else {
              const total = Number(state.aiRescan.total || 0);
              const processed = Number(state.aiRescan.processed || 0);
              const runningLabel = state.aiRescan.running ? 'running' : 'idle';
              const details = total > 0 ? processed + '/' + total : String(processed);
              const error = state.aiRescan.lastError
                ? ' | error=' + state.aiRescan.lastError
                : '';
              rescan.textContent =
                'KI-Rescan: ' +
                runningLabel +
                ' | ' +
                details +
                ' | ' +
                (state.aiRescan.message || '-') +
                error;
            }
          }
          if (system) {
            system.textContent = state.system
              ? processLine('ollama', state.system.ollama) + ' || ' + processLine('app', state.system.app) + ' || ' + processLine('mobile', state.system.mobile)
              : 'System: -';
          }
          if (pull) {
            pull.textContent = state.ollamaPull
              ? 'Ollama Pull: ' + (state.ollamaPull.running ? 'running' : 'idle') + (state.ollamaPull.model ? ' | model=' + state.ollamaPull.model : '') + (state.ollamaPull.lastError ? ' | error=' + state.ollamaPull.lastError : '') + ' | start: ' + fmtDate(state.ollamaPull.startedAt) + ' | ende: ' + fmtDate(state.ollamaPull.finishedAt)
              : 'Ollama Pull: -';
          }
          if (localSources) {
            const sources = Array.isArray(state.localSources) ? state.localSources : [];
            localSources.textContent = sources.length > 0
              ? 'Lokale Quellen: ' + sources.map((source) => (source.active ? 'aktiv ' : 'inaktiv ') + (source.displayName || source.storeId || '?') + ' (' + (source.postalCode || '-') + ', ' + (source.radiusKm || '?') + 'km)').join(' | ')
              : 'Lokale Quellen: -';
          }
          if (mobileQr) {
            const mobileState = state.system && state.system.mobile ? state.system.mobile : null;
            const expoUrl = mobileState && typeof mobileState.mobileExpoUrl === 'string' ? mobileState.mobileExpoUrl : '';
            const qrImageUrl = mobileState && typeof mobileState.mobileQrImageUrl === 'string' ? mobileState.mobileQrImageUrl : '';
            const qrUpdatedAt = mobileState && typeof mobileState.mobileQrUpdatedAt === 'string' ? mobileState.mobileQrUpdatedAt : '';
            if (expoUrl && qrImageUrl) {
              mobileQr.innerHTML =
                '<div class="sub">Expo Link: <a class="link" target="_blank" rel="noopener noreferrer" href="' + esc(expoUrl) + '">' + esc(expoUrl) + '</a></div>' +
                '<img alt="Expo QR Code" src="' + esc(qrImageUrl) + '" />' +
                '<div class="sub">QR aktualisiert: ' + esc(fmtDate(qrUpdatedAt)) + '</div>';
            } else {
              mobileQr.innerHTML = '<p class="empty">QR verfuegbar sobald Mobile gestartet ist.</p>';
            }
          }
          if (warnings) {
            warnings.innerHTML = Array.isArray(state.warnings) && state.warnings.length > 0
              ? state.warnings.map((w) => '<div class="warn">' + esc(w) + '</div>').join('')
              : '<p class="empty">Keine Warnings</p>';
          }
          if (logs) {
            logs.textContent = Array.isArray(state.logs) && state.logs.length > 0
              ? state.logs.map((entry) => '[' + entry.timestamp + '] [' + entry.level + '] ' + entry.message + (entry.context ? ' ' + JSON.stringify(entry.context) : '')).join('\\n')
              : 'Noch keine Logs geladen.';
          }
        }

        const REVIEW_REASON_LABEL = {
          // echte Blocker (rot)
          no_image: 'Bild fehlt',
          no_price: 'Preis fehlt',
          no_category: 'Kategorie fehlt',
          category_other: 'Kategorie Sonstiges',
          // offene Anreicherung (gelb) — kein Scraper-Fehler
          no_nutrition: 'Nutrition offen',
          halal_unknown: 'Halal unbekannt',
          alcohol_unknown_risk: 'Alkohol unbekannt',
          allergens_empty_risk: 'Allergene offen',
        };
        const REVIEW_REASON_ORDER = [
          'no_image',
          'no_price',
          'no_category',
          'category_other',
          'no_nutrition',
          'halal_unknown',
          'alcohol_unknown_risk',
          'allergens_empty_risk',
        ];
        const REVIEW_REASON_HARD = new Set(['no_image', 'no_price', 'no_category', 'category_other']);
        const STORE_TONES = ['#FF6B35', '#0EA5E9', '#10B981', '#8B5CF6', '#F59E0B', '#EF4444', '#14B8A6'];

        // Klartext für die Store-Status-Gründe aus dem Backend (offersQuality.ts).
        // crit = echte App-Blocker, warn = weiche Lücke, enrichment = nur offen.
        const STORE_STATUS_REASON_LABEL = {
          low_offers: 'sehr wenige Angebote',
          missing_current_price: 'aktueller Preis fehlt',
          missing_images: 'Bilder fehlen',
          uncategorized_high: 'sehr viele ohne Kategorie',
          image_gaps: 'Bilder lückenhaft',
          uncategorized_some: 'einige ohne Kategorie',
          enrichment_pending: 'Anreicherung offen (Nutrition/Halal/Allergene)',
        };
        const STORE_STATUS_ENRICHMENT_ONLY = new Set(['enrichment_pending']);

        function clampPercent(value) {
          const num = Number(value);
          if (!Number.isFinite(num)) return 0;
          return Math.max(0, Math.min(100, num));
        }

        function fmtPercent(value) {
          const num = Number(value);
          if (!Number.isFinite(num)) {
            return '-';
          }
          return num.toFixed(1).replace('.', ',') + ' %';
        }

        function coverageTier(value, good, bad) {
          const num = Number(value);
          if (!Number.isFinite(num)) return 'neutral';
          if (num >= good) return 'ok';
          if (num < bad) return 'crit';
          return 'warn';
        }

        function missingTier(value) {
          const num = Number(value);
          if (!Number.isFinite(num)) return 'neutral';
          if (num <= 5) return 'ok';
          if (num >= 25) return 'crit';
          return 'warn';
        }

        // Anreicherungs-Spalten (Streichpreis, Rabatt, Nutrition, Allergene,
        // Halal) sind KEINE Scraper-Fehler — nur noch nicht befüllt. Daher nie
        // rot: hohe Abdeckung = grün, sonst neutral/„offen", maximal gelb.
        function enrichmentTier(value, good) {
          const num = Number(value);
          if (!Number.isFinite(num)) return 'neutral';
          if (num >= (good || 60)) return 'ok';
          if (num <= 0) return 'neutral';
          return 'warn';
        }

        function kpiCard(label, value, sub, tier, barVal, unit) {
          const dotTier = tier || 'neutral';
          const hasBar = Number.isFinite(Number(barVal));
          return (
            '<div class="kpi">' +
            '<div class="kpi-label"><span class="quality-dot ' + esc(dotTier) + '"></span>' + esc(label) + '</div>' +
            '<div class="kpi-value-row"><span class="kpi-value">' + esc(value) + '</span>' + (unit ? '<span class="kpi-unit">' + esc(unit) + '</span>' : '') + '</div>' +
            (hasBar
              ? '<div class="quality-minibar ' + esc(dotTier) + '"><span style="width:' + clampPercent(barVal) + '%"></span></div>'
              : '<div class="kpi-sub">' + esc(sub || '') + '</div>') +
            '</div>'
          );
        }

        function hashText(value) {
          const raw = String(value || '');
          let hash = 0;
          for (let i = 0; i < raw.length; i += 1) {
            hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
          }
          return Math.abs(hash);
        }

        function storeLogo(storeChain) {
          const name = String(storeChain || '?').trim();
          const letter = (name.replace(/[^A-Za-z0-9ÄÖÜäöü]/g, '').charAt(0) || '?').toUpperCase();
          const color = STORE_TONES[hashText(name) % STORE_TONES.length];
          return '<span class="store-logo" style="background:' + color + '">' + esc(letter) + '</span>';
        }

        // Sortierung nach echter Kritikalität: zuerst der vom Backend
        // berechnete Status-Tier (crit > warn > ok), dann die App-Blocker
        // (fehlende Bilder/Preise/Kategorien). Anreicherung (Nutrition/Halal/
        // Allergene) fließt bewusst NICHT in die Reihenfolge ein.
        function criticalityScore(store) {
          const tier = (store.status && store.status.tier) || 'ok';
          const tierWeight = tier === 'crit' ? 100000 : tier === 'warn' ? 1000 : 0;
          const missingCategory = Number(store.withoutCategoryPercent || 0);
          return (
            tierWeight +
            (store.lowOfferCount ? 5000 : 0) +
            Math.max(0, 100 - Number(store.withCurrentPricePercent || 0)) * 3 +
            Math.max(0, 100 - Number(store.withImagePercent || 0)) * 2 +
            missingCategory * 3
          );
        }

        // Status kommt jetzt aus dem Backend (offersQuality.ts) — ehrlich und
        // testbar. Hier nur noch Tier -> Label/Tooltip übersetzen.
        function statusForStore(store) {
          const status = store.status || { tier: 'ok', reasons: [] };
          const reasons = Array.isArray(status.reasons) ? status.reasons : [];
          const reasonText = reasons
            .map((r) => STORE_STATUS_REASON_LABEL[r] || r)
            .join(' · ');
          if (status.tier === 'crit') {
            return { tier: 'crit', label: 'kritisch', title: reasonText };
          }
          if (status.tier === 'warn') {
            const onlyEnrichment = reasons.length > 0
              && reasons.every((r) => STORE_STATUS_ENRICHMENT_ONLY.has(r));
            return {
              tier: 'warn',
              label: onlyEnrichment ? 'Anreicherung offen' : 'prüfen',
              title: reasonText,
            };
          }
          return { tier: 'ok', label: 'stabil', title: reasonText || 'keine offenen Punkte' };
        }

        function pctCell(value, tier) {
          const width = clampPercent(value);
          return (
            '<td><span class="pct-cell ' + esc(tier || 'neutral') + '">' +
            '<span class="pct-val">' + fmtPercent(value) + '</span>' +
            '<span class="pct-bar"><span style="width:' + width + '%"></span></span>' +
            '</span></td>'
          );
        }

        function renderReviewFilter(report) {
          const node = byId('quality-review-filter');
          if (!node) return;
          const review = Array.isArray(report?.review) ? report.review : [];
          const counts = report?.reviewCounts || {};
          const chips = [
            '<button type="button" class="review-chip ' + (state.qualityReviewFilter === 'all' ? 'active' : '') + '" data-action="quality-review-filter" data-filter="all">Alle <span class="review-chip-count">' + review.length + '</span></button>',
          ];
          REVIEW_REASON_ORDER.forEach((reason) => {
            const count = Number(counts[reason] || 0);
            if (count <= 0) return;
            chips.push(
              '<button type="button" class="review-chip ' + (state.qualityReviewFilter === reason ? 'active' : '') + '" data-action="quality-review-filter" data-filter="' + esc(reason) + '">' +
              esc(REVIEW_REASON_LABEL[reason] || reason) +
              ' <span class="review-chip-count">' + count + '</span></button>',
            );
          });
          node.innerHTML = chips.join('');
        }

        function renderQuality() {
          const report = state.quality;
          const kpisNode = byId('quality-kpis');
          const storesBody = byId('quality-stores')?.querySelector('tbody');
          const storeMeta = byId('quality-store-meta');
          const reviewNode = byId('quality-review');
          const reviewTitle = byId('quality-review-title');
          const updatedNode = byId('quality-updated');

          if (!report) {
            if (kpisNode) kpisNode.innerHTML = '<p class="empty">Noch keine Auswertung.</p>';
            if (storesBody) storesBody.innerHTML = '';
            if (reviewNode) reviewNode.innerHTML = '';
            if (reviewTitle) reviewTitle.textContent = 'wird geladen';
            if (updatedNode) updatedNode.textContent = 'Snapshot wird ausgewertet…';
            renderReviewFilter(null);
            return;
          }

          const kpis = report.kpis || {};
          if (updatedNode) {
            const ingest = kpis.lastIngest;
            const ai = kpis.lastAiRun;
            const ingestText = ingest
              ? 'Ingest ' + (ingest.running ? 'läuft' : 'idle') + (ingest.finishedAt ? ' (' + fmtDate(ingest.finishedAt) + ')' : '')
              : 'Ingest -';
            const aiText = ai
              ? 'KI ' + (ai.running ? 'läuft' : (ai.stage || 'idle')) + (ai.finishedAt ? ' (' + fmtDate(ai.finishedAt) + ')' : '')
              : 'KI -';
            updatedNode.textContent =
              'Snapshot ' + fmtDate(kpis.updatedAt) +
              ' · berechnet ' + fmtDate(report.generatedAt) +
              ' · ' + ingestText + ' · ' + aiText;
          }

          if (kpisNode) {
            const cards = [
              kpiCard('Live-Angebote', String(kpis.liveTotal ?? 0), 'Filtered ' + (kpis.filteredTotal ?? 0) + ' · Next ' + (kpis.nextWeekTotal ?? 0), 'neutral'),
              kpiCard('Stores', String(kpis.storeCount ?? 0), 'Supermärkte im Snapshot', Number(kpis.storeCount || 0) > 0 ? 'ok' : 'crit'),
              kpiCard('Bild', fmtPercent(kpis.imageCoveragePercent), 'Live mit Produktbild', coverageTier(kpis.imageCoveragePercent, 80, 30), kpis.imageCoveragePercent),
              kpiCard('Nutrition', fmtPercent(kpis.nutritionCoveragePercent), 'Anreicherung offen', enrichmentTier(kpis.nutritionCoveragePercent, 60), kpis.nutritionCoveragePercent),
              kpiCard('Halal', fmtPercent(kpis.halalCoveragePercent), 'Anreicherung offen', enrichmentTier(kpis.halalCoveragePercent, 60), kpis.halalCoveragePercent),
              kpiCard('Allergene', fmtPercent(kpis.allergensCoveragePercent), 'Anreicherung offen', enrichmentTier(kpis.allergensCoveragePercent, 50), kpis.allergensCoveragePercent),
              kpiCard('Aktualisiert', fmtDate(kpis.updatedAt), 'letzter Snapshot', 'neutral'),
            ];
            kpisNode.innerHTML = cards.join('');
          }

          const stores = Array.isArray(report.stores) ? report.stores : [];
          const sortedStores = [...stores].sort((a, b) => criticalityScore(b) - criticalityScore(a) || String(a.storeChain || '').localeCompare(String(b.storeChain || ''), 'de'));
          if (storeMeta) {
            storeMeta.textContent = 'sortiert nach Kritikalität · ' + sortedStores.length + ' Stores';
          }
          if (storesBody) {
            if (sortedStores.length === 0) {
              storesBody.innerHTML = '<tr><td colspan="11" class="empty">Keine Stores im Snapshot.</td></tr>';
            } else {
              storesBody.innerHTML = sortedStores.map((store) => {
                const status = statusForStore(store);
                const categoryCoverage = Math.max(0, 100 - Number(store.withoutCategoryPercent || 0));
                const currentPricePct = Number.isFinite(Number(store.withCurrentPricePercent))
                  ? store.withCurrentPricePercent
                  : 100;
                return (
                  '<tr class="' + (store.lowOfferCount ? 'low-store' : '') + '">' +
                  '<td class="store-name">' + storeLogo(store.storeChain) + '<span>' + esc(store.storeChain || 'Unbekannt') + '</span>' + (store.lowOfferCount ? '<span class="low-pill">low</span>' : '') + '</td>' +
                  '<td class="total">' + esc(store.total ?? 0) + '</td>' +
                  pctCell(store.withImagePercent, coverageTier(store.withImagePercent, 80, 30)) +
                  // Akt. Preis = echter App-Blocker -> hart bewertet (rot bei Mangel)
                  pctCell(currentPricePct, coverageTier(currentPricePct, 95, 80)) +
                  // Streichpreis/Rabatt = Anreicherung -> nie rot
                  pctCell(store.withOriginalPricePercent, enrichmentTier(store.withOriginalPricePercent, 70)) +
                  pctCell(store.withSavingsPercentPercent, enrichmentTier(store.withSavingsPercentPercent, 70)) +
                  // Nutrition/Allergene/Halal = Anreicherung offen -> nie rot
                  pctCell(store.withNutritionPercent, enrichmentTier(store.withNutritionPercent, 60)) +
                  pctCell(store.withAllergensPercent, enrichmentTier(store.withAllergensPercent, 50)) +
                  pctCell(store.halalKnownPercent, enrichmentTier(store.halalKnownPercent, 60)) +
                  pctCell(categoryCoverage, missingTier(store.withoutCategoryPercent)) +
                  '<td><span class="status-badge ' + esc(status.tier) + '"' + (status.title ? ' title="' + esc(status.title) + '"' : '') + '><span class="quality-dot ' + esc(status.tier) + '"></span>' + esc(status.label) + '</span></td>' +
                  '</tr>'
                );
              }).join('');
            }
          }

          const review = Array.isArray(report.review) ? report.review : [];
          const activeFilter = state.qualityReviewFilter || 'all';
          const filteredReview = activeFilter === 'all'
            ? review
            : review.filter((item) => Array.isArray(item.reasons) && item.reasons.includes(activeFilter));
          renderReviewFilter(report);
          if (reviewTitle) {
            reviewTitle.textContent = filteredReview.length + ' von ' + review.length + ' Treffern';
          }
          if (reviewNode) {
            if (filteredReview.length === 0) {
              reviewNode.innerHTML = '<p class="empty">Keine Angebote für diesen Filter.</p>';
            } else {
              const preview = filteredReview.slice(0, 100);
              reviewNode.innerHTML = preview.map((item) => {
                const tags = (item.reasons || []).map((reason) => {
                  const label = REVIEW_REASON_LABEL[reason] || reason;
                  const cls = REVIEW_REASON_HARD.has(reason) ? 'review-tag' : 'review-tag warn';
                  return '<span class="' + cls + '">' + esc(label) + '</span>';
                }).join('');
                const numericPrice = Number(item.price);
                const priceText = Number.isFinite(numericPrice) && numericPrice > 0
                  ? numericPrice.toFixed(2).replace('.', ',') + ' €'
                  : 'kein Preis';
                return (
                  '<div class="review-item">' +
                  '<div class="review-head">' +
                  '<div class="review-name">' + esc(item.name || '-') + '</div>' +
                  '<div class="review-meta"><span>' + esc(item.storeChain || '-') + '</span><span class="dotmini"></span><span>' + esc(item.category || '-') + '</span><span class="dotmini"></span><span>' + esc(priceText) + '</span></div>' +
                  '</div>' +
                  '<div class="review-tags">' + tags + '</div>' +
                  (item.sourceUrl ? '<div class="review-foot"><a target="_blank" rel="noreferrer" href="' + esc(item.sourceUrl) + '">Quelle öffnen ↗</a></div>' : '') +
                  '</div>'
                );
              }).join('');
              if (filteredReview.length > preview.length) {
                reviewNode.innerHTML += '<p class="empty">+' + (filteredReview.length - preview.length) + ' weitere — JSON-Download zeigt alle.</p>';
              }
            }
          }
        }

        async function loadQuality() {
          try {
            state.quality = await api('/api/offers/quality', 'GET');
          } catch (error) {
            state.quality = null;
            throw error;
          }
        }

        function renderAll() {
          updateLiveWeekOptionLabels();
          refreshFilterControls();
          renderLive();
          renderFiltered();
          renderMonitor();
          renderQuality();
        }

        async function loadOffers() {
          mergeOffers(await api('/api/offers', 'GET'));
        }

        async function loadSystem() {
          mergeSystem(await api('/api/system/status', 'GET'));
        }

        async function loadAiRescanStatus() {
          const payload = await api('/api/offers/rescan-food-ai/status', 'GET');
          if (payload.aiRescan) {
            state.aiRescan = payload.aiRescan;
          }
          if (payload.oneClickAi) {
            state.oneClickAi = payload.oneClickAi;
          }
          if (payload.ingest) {
            state.ingest = payload.ingest;
          }
          if (payload.system) {
            state.system = payload.system;
          }
          if (payload.scopeSummary && typeof payload.scopeSummary === 'object') {
            state.scopeSummary = payload.scopeSummary;
          }
        }

        async function loadOneClickAiStatus() {
          const payload = await api('/api/offers/one-click-ai-live/status', 'GET');
          if (payload.oneClickAi) {
            state.oneClickAi = payload.oneClickAi;
          }
          if (payload.aiRescan) {
            state.aiRescan = payload.aiRescan;
          }
          if (payload.ingest) {
            state.ingest = payload.ingest;
          }
          if (payload.system) {
            state.system = payload.system;
          }
          if (payload.scopeSummary && typeof payload.scopeSummary === 'object') {
            state.scopeSummary = payload.scopeSummary;
          }
        }

        async function loadLogs(limit) {
          const payload = await api('/api/debug/logs?limit=' + (limit || 180), 'GET');
          state.logs = Array.isArray(payload.logs) ? payload.logs : [];
        }

        async function refresh(full, silent) {
          if (!silent) {
            status('Lade Daten...', 'info');
          }
          if (full) {
            await Promise.all([
              loadOffers(),
              loadSystem(),
              loadOneClickAiStatus(),
              loadAiRescanStatus(),
              loadLogs(200),
              loadQuality().catch(() => {}),
            ]);
          } else {
            await Promise.all([
              loadOffers(),
              loadSystem(),
              loadOneClickAiStatus(),
              loadAiRescanStatus(),
              loadQuality().catch(() => {}),
            ]);
          }
          cleanupSelections();
          renderAll();
          if (!silent) {
            const liveSummary = state.scopeSummary && state.scopeSummary.live
              ? state.scopeSummary.live
              : null;
            const nextWeekSummary = state.scopeSummary && state.scopeSummary.nextWeek
              ? state.scopeSummary.nextWeek
              : null;
            const filteredSummary = state.scopeSummary && state.scopeSummary.filtered
              ? state.scopeSummary.filtered
              : null;
            const scopeText = liveSummary && filteredSummary && nextWeekSummary
              ? ' | N/L Live ' + liveSummary.national + '/' + liveSummary.local + ' | N/L Next ' + nextWeekSummary.national + '/' + nextWeekSummary.local + ' | N/L Filtered ' + filteredSummary.national + '/' + filteredSummary.local
              : '';
            status('Aktualisiert: ' + fmtDate(state.updatedAt) + ' | Live ' + state.offers.length + ' | Naechste Woche ' + state.nextWeekOffers.length + ' | Filtered ' + state.filteredOffers.length + scopeText, 'ok');
          }
        }

        async function mutate(path, body, message) {
          mergeOffers(await api(path, 'POST', body || {}));
          await Promise.all([
            loadSystem().catch(() => {}),
            loadOneClickAiStatus().catch(() => {}),
            loadAiRescanStatus().catch(() => {}),
            loadLogs(200).catch(() => {}),
            loadQuality().catch(() => {}),
          ]);
          cleanupSelections();
          renderAll();
          status(message, 'ok');
        }

        async function move(ids, toFiltered) {
          if (!Array.isArray(ids) || ids.length === 0) {
            status('Bitte zuerst Angebote auswaehlen.', 'warn');
            return;
          }
          if (toFiltered) {
            await mutate('/api/offers/live-to-filtered', { offerIds: ids }, ids.length + ' Angebot(e) zu Filtered verschoben.');
            state.liveSelected.clear();
            return;
          }
          await mutate('/api/offers/filtered-to-live', { offerIds: ids }, ids.length + ' Angebot(e) zu Live verschoben.');
          state.filteredSelected.clear();
        }

        function getModel() {
          const input = byId('ollama-model');
          const value = input && typeof input.value === 'string' ? input.value.trim() : '';
          return value || 'qwen3:14b';
        }

        const RECOMMENDED_OLLAMA_MODELS = ['qwen3:14b', 'qwen2.5:14b-instruct', 'llama3.1:8b'];

        // Befuellt das <datalist> des Modell-Felds mit den installierten Ollama-
        // Modellen + Empfehlungen. Manuelles Eintippen bleibt immer moeglich.
        function renderOllamaModelOptions(data) {
          const list = byId('ollama-model-options');
          if (!list) {
            return;
          }
          const installed = data && data.available && Array.isArray(data.models) ? data.models : [];
          const seen = new Set();
          const options = [];
          installed.forEach((model) => {
            if (!model || !model.name || seen.has(model.name)) {
              return;
            }
            seen.add(model.name);
            const bits = [model.parameterSize, model.quantization].filter(Boolean).join(' / ');
            const label = 'installiert' + (bits ? ' / ' + bits : '');
            options.push('<option value="' + esc(model.name) + '" label="' + esc(label) + '"></option>');
          });
          RECOMMENDED_OLLAMA_MODELS.forEach((name) => {
            if (seen.has(name)) {
              return;
            }
            seen.add(name);
            options.push('<option value="' + esc(name) + '" label="empfohlen"></option>');
          });
          list.innerHTML = options.join('');
        }

        async function loadOllamaModelOptions() {
          // Bestehender Admin-Endpoint, kein neuer Backend-Endpunkt. Bei Ollama
          // offline faellt es still auf die Empfehlungen zurueck.
          try {
            const data = await api('/api/admin/ollama/models', 'GET');
            renderOllamaModelOptions(data);
          } catch {
            renderOllamaModelOptions(null);
          }
        }

        function sleep(ms) {
          return new Promise((resolve) => {
            window.setTimeout(resolve, ms);
          });
        }

        function isRefreshRunningError(error) {
          const message = error instanceof Error ? error.message : String(error || '');
          return message.toLowerCase().includes('waehrend ein refresh laeuft');
        }

        async function waitForIngestIdle(maxAttempts, delayMs) {
          let attempts = 0;
          const totalAttempts = Number(maxAttempts || 180);
          const waitMs = Number(delayMs || 800);
          while (attempts < totalAttempts) {
            await loadOneClickAiStatus().catch(() => {});
            if (!state.ingest || !state.ingest.running) {
              return true;
            }
            attempts += 1;
            await sleep(waitMs);
          }
          return !state.ingest || !state.ingest.running;
        }

        async function waitForAiRescanToFinish() {
          let attempts = 0;
          while (attempts < 1200) {
            await loadAiRescanStatus();
            renderMonitor();

            const scan = state.aiRescan;
            if (!scan || !scan.running) {
              return;
            }

            const total = Number(scan.total || 0);
            const processed = Number(scan.processed || 0);
            status(
              'KI Neu-Scan laeuft: ' +
                processed +
                '/' +
                (total > 0 ? total : '?'),
              'info',
            );
            attempts += 1;
            await sleep(900);
          }
        }

        async function waitForOneClickAiToFinish() {
          let attempts = 0;
          while (attempts < 1800) {
            await Promise.all([
              loadOneClickAiStatus().catch(() => {}),
              loadAiRescanStatus().catch(() => {}),
            ]);
            renderMonitor();

            const oneClick = state.oneClickAi;
            if (!oneClick || !oneClick.running) {
              return;
            }

            const total = Number(oneClick.total || 0);
            const processed = Number(oneClick.processed || 0);
            const details = total > 0 ? processed + '/' + total : String(processed);
            status(
              'One-Click-KI laeuft: ' +
                details +
                ' | ' +
                (oneClick.stage || 'running'),
              'info',
            );

            attempts += 1;
            await sleep(1000);
          }
        }

        async function action(name, data) {
          if (name === 'open-app-link') { window.open(FRONTEND_URL, '_blank', 'noopener,noreferrer'); return; }
          if (name === 'open-rewe-screenshot-import') { window.open('/rewe-screenshot-import', '_blank', 'noopener,noreferrer'); return; }
          if (name === 'mobile-refresh') {
            status('Mobile Refresh (Expo Taste "r") wird gesendet...', 'info');
            await api('/api/system/mobile/refresh', 'POST', {});
            await refresh(false, true);
            status('Mobile Refresh (Expo Taste "r") gesendet.', 'ok');
            return;
          }
          if (name === 'refresh-all') {
            status('Offizielle Angebote werden neu geladen...', 'info');
            await mutate(
              '/api/offers/refresh',
              { tryOllama: false, enrichWithOllama: false },
              'Offizielle Angebote neu geladen.',
            );
            return;
          }
          if (name === 'live-refresh' || name === 'filtered-refresh') { await refresh(false, false); return; }
          if (name === 'live-auto') {
            state.auto = !state.auto;
            localStorage.setItem(AUTO_KEY, state.auto ? '1' : '0');
            configureAuto();
            status(state.auto ? 'Auto-Refresh aktiv (25s).' : 'Auto-Refresh deaktiviert.', 'info');
            return;
          }
          if (name === 'toggle-live') { data.offerId && (state.liveSelected.has(data.offerId) ? state.liveSelected.delete(data.offerId) : state.liveSelected.add(data.offerId)); renderLive(); return; }
          if (name === 'toggle-filtered') { data.offerId && (state.filteredSelected.has(data.offerId) ? state.filteredSelected.delete(data.offerId) : state.filteredSelected.add(data.offerId)); renderFiltered(); return; }
          if (name === 'move-to-filtered') { await move([data.offerId], true); return; }
          if (name === 'move-to-live') { await move([data.offerId], false); return; }
          if (name === 'move-selected-to-filtered') { await move([...state.liveSelected], true); return; }
          if (name === 'move-selected-to-live') { await move([...state.filteredSelected], false); return; }
          if (name === 'copy-live-offers') {
            const activeLive = getActiveLiveOffers();
            const weekLabel = liveWeekLabel();
            const selected = selectedOffersFrom(activeLive, state.liveSelected);
            const list = selected.length > 0 ? selected : getVisibleLiveOffers();
            if (list.length === 0) {
              status('Keine Angebote (' + weekLabel + ') zum Kopieren.', 'warn');
              return;
            }
            await copyTextToClipboard(offersToClipboardText(weekLabel + ' Angebote', list));
            status(
              (selected.length > 0 ? selected.length + ' ausgewaehlte' : list.length + ' sichtbare') +
                ' Angebot(e) (' + weekLabel + ') kopiert.',
              'ok',
            );
            return;
          }
          if (name === 'download-live-offers') {
            const weekMode = getLiveWeekView();
            const activeLive = getActiveLiveOffers();
            if (!Array.isArray(activeLive) || activeLive.length === 0) {
              status('Keine Angebote (' + liveWeekLabel() + ') zum Herunterladen.', 'warn');
              return;
            }
            const isNextWeek = weekMode === 'next';
            status((isNextWeek ? 'Naechste-Woche' : 'Live') + '-Angebote werden heruntergeladen...', 'info');
            await downloadFromApi(
              isNextWeek
                ? '/api/offers/next-week/download?format=json'
                : '/api/offers/live/download?format=json',
              isNextWeek
                ? 'aichef_next_week_offers.json'
                : 'aichef_live_offers.json',
            );
            status((isNextWeek ? 'Naechste-Woche' : 'Live') + '-Angebote als Datei heruntergeladen.', 'ok');
            return;
          }
          if (name === 'copy-filtered-offers') {
            const selected = selectedOffersFrom(state.filteredOffers, state.filteredSelected);
            const list = selected.length > 0 ? selected : getVisibleFilteredOffers();
            if (list.length === 0) {
              status('Keine Filtered-Angebote zum Kopieren.', 'warn');
              return;
            }
            await copyTextToClipboard(offersToClipboardText('Filtered Angebote', list));
            status(
              (selected.length > 0 ? selected.length + ' ausgewaehlte' : list.length + ' sichtbare') +
                ' Filtered-Angebot(e) kopiert.',
              'ok',
            );
            return;
          }
          if (name === 'download-filtered-offers') {
            if (!Array.isArray(state.filteredOffers) || state.filteredOffers.length === 0) {
              status('Keine Filtered-Angebote zum Herunterladen.', 'warn');
              return;
            }
            status('Filtered-Angebote werden heruntergeladen...', 'info');
            await downloadFromApi(
              '/api/offers/filtered/download?format=json',
              'aichef_filtered_offers.json',
            );
            status('Filtered-Angebote als Datei heruntergeladen.', 'ok');
            return;
          }
          if (name === 'offers-filter-food-live') { await mutate('/api/offers/filter-food', {}, 'Food Filter ausgefuehrt.'); return; }
          if (name === 'ai-rescan-food') {
            status('KI Neu-Scan gestartet...', 'info');
            const startPayload = await api('/api/offers/rescan-food-ai/start', 'POST', { tryOllama: true });
            if (startPayload.aiRescan) {
              state.aiRescan = startPayload.aiRescan;
            }
            renderMonitor();
            await waitForAiRescanToFinish();
            await refresh(true, true);
            if (state.aiRescan && state.aiRescan.lastError) {
              status('KI Neu-Scan Fehler: ' + state.aiRescan.lastError, 'error');
              return;
            }
            const doneTotal = state.aiRescan ? Number(state.aiRescan.total || 0) : 0;
            status('KI Neu-Scan abgeschlossen (' + doneTotal + '/' + doneTotal + ').', 'ok');
            return;
          }
          if (name === 'refresh-ingest') { status('Refresh + Ingest gestartet...', 'info'); await mutate('/api/offers/refresh', { tryOllama: true, enrichWithOllama: true }, 'Refresh + Ingest abgeschlossen.'); return; }
          if (name === 'one-click-sync') { status('One Click gestartet...', 'info'); await mutate('/api/offers/one-click-sync', {}, 'One Click abgeschlossen.'); return; }
          if (name === 'one-click-ai-live') {
            status('One-Click-KI wird vorbereitet...', 'info');

            await loadOneClickAiStatus().catch(() => {});
            if (state.ingest && state.ingest.running) {
              status('Refresh laeuft noch. One-Click-KI startet automatisch danach...', 'info');
              const idle = await waitForIngestIdle(240, 900);
              if (!idle) {
                status('Refresh laeuft weiterhin. Bitte kurz warten und erneut klicken.', 'warn');
                return;
              }
            }

            let startPayload;
            try {
              startPayload = await api('/api/offers/one-click-ai-live/start', 'POST', {});
            } catch (error) {
              if (isRefreshRunningError(error)) {
                status('Refresh gerade fertig geworden. Neuer Startversuch...', 'info');
                const idle = await waitForIngestIdle(120, 800);
                if (!idle) {
                  status('Refresh laeuft weiterhin. Bitte kurz warten und erneut klicken.', 'warn');
                  return;
                }
                startPayload = await api('/api/offers/one-click-ai-live/start', 'POST', {});
              } else {
                throw error;
              }
            }

            if (startPayload.oneClickAi) {
              state.oneClickAi = startPayload.oneClickAi;
            }
            if (startPayload.aiRescan) {
              state.aiRescan = startPayload.aiRescan;
            }
            renderMonitor();
            await waitForOneClickAiToFinish();
            await refresh(true, true);
            if (state.oneClickAi && state.oneClickAi.lastError) {
              status('One-Click-KI Fehler: ' + state.oneClickAi.lastError, 'error');
              return;
            }
            status('One-Click-KI abgeschlossen und App gestartet.', 'ok');
            return;
          }
          if (name === 'clear-offers') { await mutate('/api/offers/clear', {}, 'Alle Angebote wurden geleert.'); return; }
          if (name === 'start-ollama') { await api('/api/system/start/ollama', 'POST', {}); await refresh(false, true); status('Start Ollama angefragt.', 'ok'); return; }
          if (name === 'stop-ollama') { await api('/api/system/stop/ollama', 'POST', {}); await refresh(false, true); status('Stop Ollama angefragt.', 'ok'); return; }
          if (name === 'start-app') { await api('/api/system/start/app', 'POST', {}); await refresh(false, true); status('Start App angefragt.', 'ok'); return; }
          if (name === 'stop-app') { await api('/api/system/stop/app', 'POST', {}); await refresh(false, true); status('Stop App angefragt.', 'ok'); return; }
          if (name === 'start-mobile') {
            await api('/api/system/start/mobile', 'POST', {});
            try {
              await api('/api/system/mobile/open-console', 'POST', {});
            } catch {
              // mobile start remains successful even if console window could not be opened
            }
            await refresh(false, true);
            status('Mobile Start angefragt (npm install && npm start). Expo Konsole wurde geoeffnet.', 'ok');
            return;
          }
          if (name === 'stop-mobile') { await api('/api/system/stop/mobile', 'POST', {}); await refresh(false, true); status('Mobile Stop angefragt.', 'ok'); return; }
          if (name === 'ollama-pull-model') { const model = getModel(); status('Ollama pull startet fuer ' + model + '...', 'info'); mergeSystem(await api('/api/system/ollama/pull', 'POST', { model })); await Promise.all([loadSystem(), loadLogs(200)]); renderMonitor(); status('Ollama pull gestartet: ' + model, 'ok'); return; }
          if (name === 'ollama-pull-status') { mergeSystem(await api('/api/system/ollama/pull-status', 'GET')); renderMonitor(); status('Pull Status aktualisiert.', 'ok'); return; }
          if (name === 'quality-refresh') {
            status('Datenqualität wird neu berechnet…', 'info');
            await loadQuality();
            renderQuality();
            const total = state.quality && state.quality.kpis ? state.quality.kpis.liveTotal : 0;
            const review = state.quality && Array.isArray(state.quality.review) ? state.quality.review.length : 0;
            status('Datenqualität aktualisiert (' + total + ' Live, ' + review + ' Review).', 'ok');
            return;
          }
          if (name === 'quality-download') {
            status('Datenqualität-JSON wird heruntergeladen…', 'info');
            await downloadFromApi('/api/offers/quality/download', 'aichef_offers_quality.json');
            status('Datenqualität-JSON heruntergeladen.', 'ok');
            return;
          }
          if (name === 'quality-review-filter') {
            state.qualityReviewFilter = data.filter || 'all';
            renderQuality();
            return;
          }
          if (name === 'debug-load-logs') { await loadLogs(300); renderMonitor(); status('Logs geladen.', 'ok'); return; }
          if (name === 'debug-clear') { await api('/api/debug/clear', 'POST', {}); await loadLogs(80); renderMonitor(); status('Logs geleert.', 'ok'); return; }
          if (name === 'debug-refresh') { await Promise.all([loadOffers(), loadSystem(), loadOneClickAiStatus(), loadAiRescanStatus()]); cleanupSelections(); renderAll(); status('Status aktualisiert.', 'ok'); }
        }
        function attachEvents() {
          document.addEventListener('click', (event) => {
            const target = event.target;
            if (!(target instanceof Element)) {
              return;
            }
            const actionNode = target.closest('[data-action]');
            if (!actionNode) {
              return;
            }
            const name = actionNode.getAttribute('data-action');
            if (!name) {
              return;
            }
            const offerId = actionNode.getAttribute('data-offer-id') || '';
            const keyword = actionNode.getAttribute('data-keyword') || '';
            const filter = actionNode.getAttribute('data-filter') || '';
            action(name, { offerId, keyword, filter }).catch((error) => {
              reportUnknownClientError(error, 'action', { action: name });
              status(error instanceof Error ? error.message : 'Unbekannter Fehler', 'error');
            });
          });

          document.addEventListener('input', (event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) {
              return;
            }
            if (target.id === 'live-search' || target.id === 'live-store' || target.id === 'live-category' || target.id === 'live-scope') {
              renderLive();
              return;
            }
            if (target.id === 'filtered-search' || target.id === 'filtered-store' || target.id === 'filtered-category' || target.id === 'filtered-scope') {
              renderFiltered();
              return;
            }
          });

          document.addEventListener('change', (event) => {
            const target = event.target;
            if (!(target instanceof Element)) {
              return;
            }
            if (target.id === 'live-week-view') {
              state.liveSelected.clear();
              refreshFilterControls();
              renderLive();
              status('Live-Ansicht: ' + liveWeekLabel(), 'info');
              return;
            }
          });

          const themeToggle = byId('theme-toggle');
          if (themeToggle) {
            themeToggle.addEventListener('click', () => {
              const current = document.documentElement.getAttribute('data-theme') || 'light';
              setTheme(current === 'dark' ? 'light' : 'dark');
            });
          }

          window.addEventListener('beforeunload', () => {
            if (state.autoTimer) {
              window.clearInterval(state.autoTimer);
            }
          });
        }

        function hydrate() {
          const savedTheme = localStorage.getItem(THEME_KEY);
          setTheme(savedTheme === 'dark' ? 'dark' : 'light');

          state.auto = localStorage.getItem(AUTO_KEY) !== '0';
          configureAuto();

          const modelInput = byId('ollama-model');
          if (modelInput && !modelInput.value) {
            modelInput.value = 'qwen3:14b';
          }
          renderOllamaModelOptions(null);
          loadOllamaModelOptions().catch(() => {});
        }

        async function init() {
          attachEvents();
          hydrate();
          try {
            await refresh(true, false);
          } catch (error) {
            reportUnknownClientError(error, 'init');
            status(error instanceof Error ? error.message : 'Dashboard konnte nicht geladen werden.', 'error');
          }
        }

        init();
      })();
    </script>
  </body>
</html>`;
}
