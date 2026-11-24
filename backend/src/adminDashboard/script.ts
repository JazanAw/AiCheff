// Vanilla-JS client for /admin-v2.
// Renders the Control-Center layout using REAL backend data:
//   /api/admin/overview · /api/admin/subscriptions · /api/admin/trends
//   /api/admin/sources · /api/admin/jobs · /api/offers · /api/offers/quality
//   /api/system/status · /api/debug/logs
//
// Component renderers (kpiBar, statusBadge, pctCell, attnRow, qaRow, feedRow,
// rankRow, jobRow, svc) match the Claude Design "Control Center.html" handoff.

export function adminDashboardScript(frontendUrl: string): string {
  return `
(() => {
  const FRONTEND_URL = ${JSON.stringify(frontendUrl)};
  const THEME_KEY = 'aichef.cc.theme';
  const ACTIVE_KEY = 'aichef.cc.screen';
  const AUTO_INTERVAL_MS = 25000;

  // ---------- Constants ----------
  const STORE_COLORS = {
    'REWE': '#CC071E', 'Edeka': '#1F5BAA', 'EDEKA': '#1F5BAA',
    'ALDI SUED': '#00BCE4', 'Aldi Süd': '#00BCE4', 'ALDI NORD': '#005EA8', 'Aldi Nord': '#005EA8',
    'Lidl': '#0050AA', 'LIDL': '#0050AA',
    'Kaufland': '#E10915', 'KAUFLAND': '#E10915',
    'PENNY': '#CC0000', 'Penny': '#CC0000',
    'Netto': '#FFD500', 'NETTO': '#FFD500',
    'HIT': '#E30613', 'NORMA': '#003D7E', 'nahkauf': '#0099CC',
  };
  const REVIEW_REASON_LABEL = {
    no_image: 'Bild fehlt', no_price: 'Preis fehlt', no_category: 'Kategorie fehlt',
    category_other: 'Kategorie Sonstiges', no_nutrition: 'Nutrition offen',
    halal_unknown: 'Halal unbekannt', alcohol_unknown_risk: 'Alkohol unbekannt',
    allergens_empty_risk: 'Allergene offen',
  };
  // Hart (rot) = echte App-Blocker. Anreicherung (Nutrition/Halal/Allergene) ist
  // bewusst NICHT hart — nur offene Zusatzdaten, daher gelb.
  const HARD_REASONS = new Set(['no_image','no_price','no_category','category_other']);
  // Klartext für die Backend-Store-Status-Gründe (offersQuality.ts).
  const STORE_STATUS_REASON_LABEL = {
    low_offers: 'sehr wenige Angebote',
    missing_current_price: 'aktueller Preis fehlt',
    missing_images: 'Bilder fehlen',
    uncategorized_high: 'sehr viele ohne Kategorie',
    image_gaps: 'Bilder lückenhaft',
    broken_images: 'Broken Images (404 / kein Bild)',
    uncategorized_some: 'einige ohne Kategorie',
    enrichment_pending: 'Anreicherung offen (Nutrition/Halal/Allergene)',
  };
  const STORE_STATUS_ENRICHMENT_ONLY = new Set(['enrichment_pending']);

  // ---------- State ----------
  const state = {
    overview: null, quality: null, trends: null, subscriptions: null,
    sources: null, jobs: null, system: null, logs: [],
    userEvents: null, jobsHistory: null, ollamaModels: null, ollamaConfig: null,
    history: null, historyRuns: null, historyWeeks: null,
    selectedWeek: null, weekDetail: null, weekDetailLoading: false, weekDetailError: null,
    weekSearch: '', weekStoreFilter: '', weekOnlyRepeated: false, weekOnlyPriceChanged: false,
    offers: { live: [], next: [], filtered: [], updatedAt: null },
    offerTab: 'live',
    storeFilter: '',
    offersSearch: '',
    selectedOffers: new Set(),
    qualityFilter: 'all',
    logLevel: 'all',
    recipes: null,
    recipesFilter: 'all',
    recipesCuisine: 'all',
    recipesSearch: '',
    activeScreen: 'overview',
    lastSupabaseSync: null,
    qualityAiRunning: false,
    qualityAiStatus: null,
    // Which scan mode the user last launched ('all' | 'missing_or_uncertain').
    qualityAiMode: 'all',
    // Last comparison KPIs (full vs. incremental) + live ETA from /status.
    qualityAiComparison: null,
    qualityAiEta: null,
    // Ollama runtime snapshot (managed/external/unavailable) from /status.
    qualityOllamaRuntime: null,
    // Selected store chains for the scoped KI-Rescan. [] = alle Stores.
    qualityStoreScope: [],
    weeklyScan: null,
    weeklyScanPolling: false,
    scanV2: null,
    scanV2Polling: false,
  };

  // ---------- Helpers ----------
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  function fmtPct(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '–';
    return n.toFixed(1).replace('.', ',') + ' %';
  }
  function fmtNumber(value) {
    if (value === null || value === undefined) return '–';
    return Number(value).toLocaleString('de-DE');
  }
  function fmtPrice(value, currency) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '–';
    return n.toFixed(2).replace('.', ',') + ' ' + (currency || 'EUR');
  }
  function fmtDate(value) {
    if (!value) return '–';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
  }
  function fmtTime(value) {
    if (!value) return '–';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '–';
    return d.toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' });
  }
  function fmtRelative(value) {
    if (!value) return '–';
    const ms = Date.now() - new Date(value).getTime();
    if (!Number.isFinite(ms) || ms < 0) return fmtDate(value);
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + ' s';
    if (s < 3600) return Math.floor(s/60) + ' min';
    if (s < 86400) return Math.floor(s/3600) + ' h';
    return Math.floor(s/86400) + ' d';
  }
  function tierHigh(v, okAt, warnAt) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 'neutral';
    if (n >= okAt) return 'ok';
    if (n >= warnAt) return 'warn';
    return 'crit';
  }
  function tierLow(v, okAt, warnAt) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 'neutral';
    if (n <= okAt) return 'ok';
    if (n <= warnAt) return 'warn';
    return 'crit';
  }
  function statusTone(status) {
    if (status === 'ok' || status === 'done' || status === 'idle') return 'ok';
    if (status === 'running') return 'info';
    if (status === 'error' || status === 'crit') return 'crit';
    if (status === 'warn') return 'warn';
    return 'neutral';
  }
  function statusLabel(status) {
    if (status === 'ok' || status === 'done') return 'ok';
    if (status === 'running') return 'läuft';
    if (status === 'error') return 'Fehler';
    if (status === 'idle') return 'idle';
    return status || '–';
  }
  function storeLogo(name) {
    const c = STORE_COLORS[name] || '#6B7280';
    const letter = String(name || '?').replace(/[^a-zA-Z]/g,'').slice(0,1) || '?';
    const textColor = (name === 'Netto' || name === 'NETTO') ? '#1A1A1A' : '#fff';
    return '<span class="store-logo" style="background:' + c + ';color:' + textColor + '">' + esc(letter) + '</span>';
  }
  // Anreicherungs-Spalten nie rot: hohe Abdeckung = grün, sonst neutral/gelb.
  function tierSoft(v, okAt) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 'neutral';
    if (n >= (okAt || 60)) return 'ok';
    if (n <= 0) return 'neutral';
    return 'warn';
  }
  function pctCell(value, opts) {
    const o = opts || {};
    const tier = o.soft
      ? tierSoft(value, o.okAt || 60)
      : o.invert
        ? tierLow(value, o.okAt || 5, o.warnAt || 15)
        : tierHigh(value, o.okAt || 80, o.warnAt || 50);
    const w = Math.max(0, Math.min(100, Number(value) || 0));
    return '<td><span class="pct-cell ' + tier + '">' +
      '<span class="pct-val">' + fmtPct(value) + '</span>' +
      '<span class="pct-bar"><span style="width:' + w + '%"></span></span>' +
      '</span></td>';
  }

  // ---------- Lucide icons (inline) ----------
  const I = {
    home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2h-4v-7h-6v7H5a2 2 0 0 1-2-2z"/>',
    tag: '<path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><circle cx="7" cy="7" r="1.5"/>',
    bar: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>',
    trend: '<polyline points="3 17 9 11 13 15 21 7"/><polyline points="14 7 21 7 21 14"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/>',
    inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    server: '<rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><line x1="6" y1="7" x2="6.01" y2="7"/><line x1="6" y1="17" x2="6.01" y2="17"/>',
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    alertC: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    alertT: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    bolt: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    cloud: '<path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/>',
    fileTxt: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
    img: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
    no_img: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="3" x2="21" y2="21"/>',
    open: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
    plug: '<path d="M9 2v6"/><path d="M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0V8z"/><path d="M12 17v5"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    play: '<polygon points="5 3 19 12 5 21 5 3"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
    moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  };
  function ico(key, size) {
    const s = size || 14;
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (I[key] || '') + '</svg>';
  }

  // ---------- Navigation ----------
  const NAV_OPS = [
    { id: 'overview', label: 'Übersicht',     icoKey: 'home',   numKey: null },
    { id: 'offers',   label: 'Angebote',      icoKey: 'tag',    numKey: 'liveCount' },
    { id: 'quality',  label: 'Datenqualität', icoKey: 'bar',    dotKey: 'qualityDot' },
    { id: 'recipes',  label: 'Rezepte',       icoKey: 'book',   numKey: 'recipesCount' },
    { id: 'trends',   label: 'Trends',        icoKey: 'trend',  dotKey: 'trendsDot' },
    { id: 'users',    label: 'Nutzer & Abos', icoKey: 'users',  numKey: 'usersCount' },
  ];
  const NAV_SYS = [
    { id: 'ai',       label: 'KI & Jobs',         icoKey: 'cpu',     dotKey: 'aiDot' },
    { id: 'imports',  label: 'Imports & Quellen', icoKey: 'inbox',   dotKey: 'sourcesDot' },
    { id: 'system',   label: 'System & Logs',     icoKey: 'server',  dotKey: 'systemDot' },
  ];
  const NAV_HANDOFF = [
    { id: 'spec', label: 'Spec / Übergabe', icoKey: 'book' },
  ];

  function navStats() {
    const stats = {};
    if (state.overview) {
      const w = state.overview.warnings || [];
      stats.qualityDot = w.some((x) => x.code && x.code.startsWith('coverage.')) ? 'warn' : 'ok';
      stats.systemDot = w.some((x) => x.code === 'system.ollama_offline' || x.code === 'client.errors_present') ? 'warn' : 'ok';
      stats.aiDot = w.some((x) => x.code === 'system.ollama_offline') ? 'crit' : 'ok';
      stats.usersCount = state.overview.kpis.totalUsers != null ? fmtNumber(state.overview.kpis.totalUsers) : '–';
      stats.liveCount = fmtNumber(state.overview.kpis.liveOffers);
    }
    if (state.sources) {
      const anyCrit = (state.sources.sources || []).some((s) => (s.warnings || []).length > 0);
      stats.sourcesDot = anyCrit ? 'warn' : 'ok';
    }
    if (state.trends) {
      stats.trendsDot = (state.trends.missingDataNotes && state.trends.missingDataNotes.length > 0) ? 'info' : 'ok';
    }
    if (state.recipes && state.recipes.available) {
      stats.recipesCount = fmtNumber(state.recipes.total);
    }
    return stats;
  }

  function renderNav() {
    const stats = navStats();
    const buildItem = (it) => {
      const num = it.numKey && stats[it.numKey] ? '<span class="ni-num">' + esc(stats[it.numKey]) + '</span>' : '';
      const dot = it.dotKey && stats[it.dotKey] ? '<span class="ni-dot ' + stats[it.dotKey] + '"></span>' : '';
      return '<button class="nav-item" data-screen="' + it.id + '">' +
        '<span class="ni-ico">' + ico(it.icoKey, 16) + '</span>' +
        '<span>' + esc(it.label) + '</span>' +
        num + dot +
      '</button>';
    };
    $('nav-ops').innerHTML = NAV_OPS.map(buildItem).join('');
    $('nav-sys').innerHTML = NAV_SYS.map(buildItem).join('');
    $('nav-handoff').innerHTML = NAV_HANDOFF.map(buildItem).join('');
    document.querySelectorAll('.nav-item').forEach((n) => {
      n.classList.toggle('active', n.dataset.screen === state.activeScreen);
    });
  }

  function activateScreen(id) {
    state.activeScreen = id;
    try { localStorage.setItem(ACTIVE_KEY, id); } catch {}
    document.querySelectorAll('.screen').forEach((el) => el.classList.toggle('active', el.dataset.screen === id));
    document.querySelectorAll('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.screen === id));
    const all = [...NAV_OPS, ...NAV_SYS, ...NAV_HANDOFF];
    const found = all.find((x) => x.id === id);
    if (found) $('crumb').textContent = found.label;
    window.scrollTo({ top: 0 });
    if (id === 'offers' && !state.offers) loadOffers().catch(() => {});
    if (id === 'trends' && !state.trends) loadTrends().catch(() => {});
    if (id === 'recipes' && !state.recipes) loadRecipes().catch(() => {});
    if (id === 'recipes' && !state.offerQuality) loadOfferQuality().catch(() => {});
    if (id === 'quality') {
      if (!state.history) loadHistory().catch(() => {});
      loadQualityAiStatus().catch(() => {});
    }
    if (id === 'users') {
      if (!state.subscriptions) loadSubscriptions().catch(() => {});
      if (!state.userEvents) loadUserEvents().catch(() => {});
    }
    if (id === 'imports') {
      if (!state.sources) loadSources().catch(() => {});
      loadScanReport().catch(() => {});
      loadWeeklyScan().catch(() => {});
    }
    if (id === 'ai') {
      if (!state.jobsHistory) loadJobsHistory().catch(() => {});
      if (!state.ollamaModels) loadOllamaModels().catch(() => {});
      if (!state.ollamaConfig) loadOllamaConfig().catch(() => {});
    }
  }

  // ---------- Theme ----------
  function setTheme(theme) {
    const t = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
    $('theme-label').textContent = t === 'dark' ? 'Light' : 'Dark';
    $('theme-ico').innerHTML = t === 'dark' ? I.moon : I.sun;
    try { localStorage.setItem(THEME_KEY, t); } catch {}
  }

  // ---------- Status bar ----------
  function status(message, kind) {
    const node = $('status-bar');
    if (!node) return;
    node.textContent = message;
    node.dataset.kind = kind || 'info';
  }

  // ---------- API ----------
  // Every call is time-bounded (AbortController) so a single slow/hanging
  // endpoint can NEVER freeze the dashboard on „Lade Daten…" — it fails fast and
  // the resilient boot (Promise.allSettled) continues with whatever loaded.
  async function api(path, method, body, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 12000);
    let res;
    try {
      res = await fetch(path, {
        method: method || 'GET',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: method && method !== 'GET' ? JSON.stringify(body || {}) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error(
        err && err.name === 'AbortError'
          ? 'Zeitüberschreitung (' + (timeoutMs || 12000) + ' ms): ' + path
          : 'Netzwerkfehler: ' + path,
      );
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let data = {};
    if (text) { try { data = JSON.parse(text); } catch {} }
    if (!res.ok) {
      const e = new Error(data && data.error ? String(data.error) : 'HTTP ' + res.status);
      // Den Response-Body + Status mittragen, damit Aufrufer (z. B. der ALDI-Import)
      // eine 409-„Phase 2 erforderlich"-Antwort mit Review-Report rendern können,
      // statt nur die Fehlermeldung zu zeigen.
      e.status = res.status;
      e.data = data;
      throw e;
    }
    return data;
  }
  async function download(path, fallbackName) {
    const r = await fetch(path);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const blob = await r.blob();
    const disp = r.headers.get('content-disposition') || '';
    const m = disp.match(/filename="?([^";]+)"?/i);
    const name = (m && m[1]) || fallbackName;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  // ---------- Loaders ----------
  async function loadOverview() { state.overview = await api('/api/admin/overview'); renderOverview(); renderNav(); }
  async function loadOffers() {
    const p = await api('/api/offers');
    state.offers = {
      live: Array.isArray(p.offers) ? p.offers : [],
      next: Array.isArray(p.nextWeekOffers) ? p.nextWeekOffers : [],
      filtered: Array.isArray(p.filteredOffers) ? p.filteredOffers : [],
      updatedAt: p.updatedAt || null,
    };
    renderOffers();
  }
  async function loadQuality() { state.quality = await api('/api/offers/quality'); renderQuality(); renderNav(); }
  async function loadRecipes() { state.recipes = await api('/api/admin/recipes'); renderRecipes(); renderNav(); }
  async function loadOfferQuality() { state.offerQuality = await api('/api/cheffity/offer-quality'); renderOfferQuality(); }
  async function loadHistory() {
    // NOTE: only the week OVERVIEW is loaded here. The (potentially large)
    // per-week offer list is loaded lazily when the user clicks a KW card.
    const [hist, runs, weeks] = await Promise.all([
      api('/api/admin/history'),
      api('/api/admin/history/runs?limit=10').catch(() => ({ available: false, runs: [] })),
      api('/api/admin/history/weeks').catch(() => ({ available: false, weeks: [] })),
    ]);
    state.history = hist;
    state.historyRuns = runs;
    state.historyWeeks = weeks;
    renderHistory();
  }
  async function loadHistoryWeek(year, week) {
    state.selectedWeek = { year: Number(year), week: Number(week) };
    state.weekDetail = null;
    state.weekDetailError = null;
    state.weekDetailLoading = true;
    // Reset per-week filters so a new week starts clean.
    state.weekSearch = '';
    state.weekStoreFilter = '';
    state.weekOnlyRepeated = false;
    state.weekOnlyPriceChanged = false;
    renderHistoryWeeks();
    renderHistoryWeekDetail();
    try {
      const detail = await api('/api/admin/history/week?year=' + Number(year) + '&week=' + Number(week) + '&limit=500');
      state.weekDetail = detail;
    } catch (err) {
      state.weekDetailError = (err && err.message) || 'Fehler beim Laden der KW.';
    } finally {
      state.weekDetailLoading = false;
      renderHistoryWeekDetail();
    }
  }
  async function loadTrends() { state.trends = await api('/api/admin/trends'); renderTrends(); renderNav(); }
  async function loadSubscriptions() { state.subscriptions = await api('/api/admin/subscriptions'); renderUsers(); renderNav(); }
  async function loadSources() { state.sources = await api('/api/admin/sources'); renderImports(); renderNav(); }
  // Per-shop import health (strategy / web verification / missing) from the scan
  // report — surfaces REWE manual import, Lidl critical, Kaufland warning, etc.
  async function loadScanReport() {
    try {
      state.scanReport = await api('/api/offers/scan-report');
      renderImportHealth();
    } catch {}
  }
  async function loadWeeklyScan() {
    try {
      state.weeklyScan = await api('/api/offers/weekly-auto-scan/status');
      renderWeeklyScan();
      const ws = state.weeklyScan && state.weeklyScan.weeklyScan;
      if (ws && ws.running && !state.weeklyScanPolling) {
        pollWeeklyScan().catch(() => {});
      }
    } catch {}
  }
  // Honest phase status: red on error, never green for a 0-KI failure.
  function renderWeeklyScan() {
    const host = $('weekly-scan-status');
    const badge = $('weekly-scan-phase-badge');
    const startBtn = $('weekly-scan-btn');
    const cancelBtn = $('weekly-scan-cancel-btn');
    const data = state.weeklyScan;
    const ws = data && data.weeklyScan;
    const cfg = (data && data.config) || {};
    const running = !!(ws && ws.running);
    if (startBtn) startBtn.disabled = running;
    if (cancelBtn) cancelBtn.style.display = running ? '' : 'none';
    if (!host) return;
    if (!ws || (ws.phase === 'idle' && !ws.startedAt)) {
      if (badge) badge.textContent = 'idle';
      const excl = (cfg.excludedStores || []).join(', ') || 'REWE';
      host.style.color = '';
      host.innerHTML = 'Noch kein Wochen-Auto-Scan gelaufen. Ausgeschlossen: ' + esc(excl) +
        ' · Modell: ' + esc((state.ollamaConfig && state.ollamaConfig.model) || 'qwen3:14b');
      return;
    }
    const failed = !running && (ws.phase === 'error' || (Number(ws.scannedCount) > 0 && Number(ws.aiClassifiedCount) === 0 && ws.phase !== 'cancelled'));
    if (badge) badge.textContent = ws.phase || '–';
    const parts = [];
    parts.push('Phase: <strong>' + esc(ws.phase) + '</strong>');
    if (ws.isoWeek) parts.push('KW ' + esc(ws.isoWeek));
    if (running && Number(ws.total) > 0) parts.push(fmtNumber(ws.processed) + '/' + fmtNumber(ws.total));
    parts.push('Ausgeschlossen: ' + esc((ws.excludedStores || cfg.excludedStores || []).join(', ') || '–'));
    parts.push('Modell: ' + esc(ws.model || (state.ollamaConfig && state.ollamaConfig.model) || '–'));
    if (ws.gpu) parts.push('GPU: ' + esc(ws.gpu.name) + ' (' + fmtNumber(ws.gpu.freeMb) + ' MB frei)');
    if (!running && Number(ws.scannedCount) > 0) parts.push(fmtNumber(ws.aiClassifiedCount) + ' per KI · ' + fmtNumber(ws.fallbackCount) + ' per Regeln');
    if (ws.lastError) parts.push('<span style="color:var(--danger)">' + esc(ws.lastError) + '</span>');
    else if (failed) parts.push('<span style="color:var(--danger)">0 KI-Treffer (Fallback) — Ollama/GPU prüfen</span>');
    host.style.color = failed ? 'var(--danger)' : '';
    host.innerHTML = parts.join(' · ');
  }
  async function pollWeeklyScan() {
    state.weeklyScanPolling = true;
    try {
      for (let i = 0; i < 2400; i++) {
        await sleep(3000);
        let data;
        try { data = await api('/api/offers/weekly-auto-scan/status'); }
        catch { continue; }
        state.weeklyScan = data;
        renderWeeklyScan();
        const ws = data.weeklyScan || {};
        if (!ws.running) {
          if (ws.phase === 'done') {
            await Promise.all([loadSources(), loadOffers(), loadOverview(), loadQuality()]).catch(() => {});
            status('Wochen-Auto-Scan fertig (KW ' + (ws.isoWeek || '–') + '): ' + fmtNumber(ws.aiClassifiedCount) + ' per KI.', 'ok');
          } else if (ws.phase === 'cancelled') {
            status('Wochen-Auto-Scan abgebrochen.', 'warn');
          } else {
            status('Wochen-Auto-Scan fehlgeschlagen: ' + (ws.lastError || 'unbekannt'), 'error');
          }
          renderWeeklyScan();
          return;
        }
      }
    } finally {
      state.weeklyScanPolling = false;
    }
  }
  async function startWeeklyScan() {
    try {
      status('Wochen-Auto-Scan wird gestartet (Preflight läuft)…', 'info');
      await api('/api/offers/weekly-auto-scan/start', 'POST', {});
      await loadWeeklyScan();
      status('Wochen-Auto-Scan läuft. Fortschritt unter „Imports & Quellen".', 'ok');
      pollWeeklyScan().catch(() => {});
    } catch (error) {
      status((error && error.message) || 'Wochen-Auto-Scan konnte nicht gestartet werden.', 'error');
      await loadWeeklyScan().catch(() => {});
    }
  }
  async function cancelWeeklyScan() {
    const btn = $('weekly-scan-cancel-btn');
    if (btn) btn.disabled = true;
    try {
      await api('/api/offers/weekly-auto-scan/cancel', 'POST', {});
      status('Wochen-Auto-Scan wird abgebrochen…', 'warn');
    } catch (error) {
      status((error && error.message) || 'Abbruch fehlgeschlagen.', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ---------- Angebots-Scan 2.0 ----------
  const SCAN_V2_PHASE_LABEL = {
    idle: 'idle', phase1_scraping: 'Phase 1 · Scrape', phase1_image_check: 'Phase 1 · Bildcheck',
    phase1_done: 'Phase 1 fertig', phase2_food_analysis: 'Phase 2 · Food-Analyse',
    paused: 'pausiert', resuming: 'wird fortgesetzt',
    done: 'fertig', error: 'Fehler', cancelled: 'abgebrochen',
  };
  const SCAN_V2_MODE_LABEL = { phase1: 'Phase 1 (Schnellscan)', phase2: 'Phase 2 (Food-Analyse)', phase1_phase2: 'Phase 1 + 2' };
  function toggleScanV2Menu() {
    const menu = $('scan-v2-menu'); const tog = $('scan-v2-toggle');
    if (!menu) return;
    const open = menu.hasAttribute('hidden');
    if (open) { menu.removeAttribute('hidden'); if (tog) tog.setAttribute('aria-expanded', 'true'); }
    else { menu.setAttribute('hidden', ''); if (tog) tog.setAttribute('aria-expanded', 'false'); }
  }
  function closeScanV2Menu() {
    const menu = $('scan-v2-menu'); const tog = $('scan-v2-toggle');
    if (menu && !menu.hasAttribute('hidden')) menu.setAttribute('hidden', '');
    if (tog) tog.setAttribute('aria-expanded', 'false');
  }
  async function loadScanV2() {
    try {
      state.scanV2 = await api('/api/offers/scan-v2/status');
      renderScanV2();
      const sv = state.scanV2 && state.scanV2.scanV2;
      if (sv && sv.running && !state.scanV2Polling) pollScanV2().catch(() => {});
    } catch {}
  }
  function scanV2StatChip(label, value) {
    return '<span class="pill" style="font-size:11px"><strong>' + esc(String(value)) + '</strong> ' + esc(label) + '</span>';
  }
  function renderScanV2() {
    const section = $('scan-v2-section');
    const host = $('scan-v2-status');
    const badge = $('scan-v2-phase-badge');
    const statsHost = $('scan-v2-stats');
    const cancelBtn = $('scan-v2-cancel-btn');
    const pauseBtn = $('scan-v2-pause-btn');
    const resumeBtn = $('scan-v2-resume-btn');
    const startBtn = $('scan-v2-btn');
    const data = state.scanV2;
    const sv = data && data.scanV2;
    const checkpoint = data && data.checkpoint;
    const running = !!(sv && sv.running);
    // Pausiert = explizit paused ODER (nicht laufend, aber ein Checkpoint liegt
    // vor — etwa nach Backend-Neustart). Beides bietet „Fortsetzen" an.
    const paused = (!!(sv && sv.paused) || !!checkpoint) && !running;
    if (cancelBtn) cancelBtn.style.display = (running || paused) ? '' : 'none';
    if (pauseBtn) pauseBtn.style.display = running ? '' : 'none';
    if (resumeBtn) resumeBtn.style.display = paused ? '' : 'none';
    if (startBtn) startBtn.disabled = running || paused;
    // Section zeigen, wenn schon mal gelaufen, gerade läuft, oder pausiert.
    if (section) section.style.display = (sv && (sv.startedAt || running || paused)) ? '' : 'none';
    if (!sv) return;
    if (badge) badge.textContent = SCAN_V2_PHASE_LABEL[sv.phase] || sv.phase || '–';
    const failed = !running && sv.phase === 'error';
    const parts = [];
    parts.push('Modus: <strong>' + esc(SCAN_V2_MODE_LABEL[sv.mode] || sv.mode || '–') + '</strong>');
    parts.push('Phase: <strong>' + esc(SCAN_V2_PHASE_LABEL[sv.phase] || sv.phase) + '</strong>');
    if ((running || paused) && Number(sv.total) > 0) {
      const pct = Math.round((Number(sv.processed) / Number(sv.total)) * 100);
      parts.push(fmtNumber(sv.processed) + '/' + fmtNumber(sv.total) + ' (~' + pct + '%)');
    }
    if (paused && sv.pausedAt) {
      let since = sv.pausedAt;
      try { since = new Date(sv.pausedAt).toLocaleString('de-DE'); } catch (e) {}
      parts.push('pausiert seit <strong>' + esc(since) + '</strong>');
    }
    if (sv.message) parts.push(esc(sv.message));
    if (sv.lastError) parts.push('<span style="color:var(--danger)">' + esc(sv.lastError) + '</span>');
    if (host) { host.style.color = failed ? 'var(--danger)' : ''; host.innerHTML = parts.join(' · '); }
    if (statsHost) {
      const p1 = sv.phase1 || {}; const p2 = sv.phase2 || {};
      const chips = [];
      if (p1.scrapedCount || p1.liveCount || p1.imageCheckedCount) {
        chips.push('<span style="font-size:11px;color:var(--muted);align-self:center">Phase 1:</span>');
        chips.push(scanV2StatChip('gescrapt', p1.scrapedCount));
        chips.push(scanV2StatChip('Live', p1.liveCount));
        chips.push(scanV2StatChip('nächste Woche', p1.nextWeekCount));
        chips.push(scanV2StatChip('Non-Food gefiltert', p1.nonFoodFilteredCount));
        chips.push(scanV2StatChip('Bilder geprüft', p1.imageCheckedCount));
        chips.push(scanV2StatChip('broken', p1.brokenImageCount));
      }
      if (p2.candidatesCount || p2.sentToModel || p2.aiClassifiedCount) {
        chips.push('<span style="font-size:11px;color:var(--muted);align-self:center;margin-left:8px">Phase 2:</span>');
        chips.push(scanV2StatChip('Kandidaten', p2.candidatesCount));
        chips.push(scanV2StatChip('an Modell', p2.sentToModel));
        chips.push(scanV2StatChip('per KI', p2.aiClassifiedCount));
        chips.push(scanV2StatChip('Cache-Reuse', p2.reusedProductAnalysis));
        chips.push(scanV2StatChip('Review', p2.reviewNeededCount));
        chips.push(scanV2StatChip('Non-Food übersprungen', p2.skippedNonFoodCount));
        chips.push(scanV2StatChip('gesperrt', p2.skippedLockedCount));
        chips.push(scanV2StatChip('NextWeek übersprungen', p2.skippedNextWeekCount));
      }
      statsHost.innerHTML = chips.join('');
    }
  }
  async function pollScanV2() {
    state.scanV2Polling = true;
    try {
      for (let i = 0; i < 2400; i++) {
        await sleep(3000);
        let data;
        try { data = await api('/api/offers/scan-v2/status'); } catch { continue; }
        state.scanV2 = data;
        renderScanV2();
        const sv = data.scanV2 || {};
        if (!sv.running) {
          if (sv.phase === 'done') {
            await Promise.all([loadOffers(), loadOverview(), loadQuality()]).catch(() => {});
            status('Angebots-Scan 2.0 fertig: ' + fmtNumber((sv.phase1 || {}).liveCount || 0) + ' Live.', 'ok');
          } else if (sv.phase === 'paused') {
            status('Angebots-Scan 2.0 pausiert bei ' + fmtNumber(sv.processed) + '/' + fmtNumber(sv.total) + '. „Fortsetzen" setzt am Checkpoint fort.', 'warn');
            await Promise.all([loadOffers(), loadOverview()]).catch(() => {});
          } else if (sv.phase === 'cancelled') {
            status('Angebots-Scan 2.0 abgebrochen. Phase-1-Daten bleiben erhalten.', 'warn');
            await Promise.all([loadOffers(), loadOverview()]).catch(() => {});
          } else {
            status('Angebots-Scan 2.0 fehlgeschlagen: ' + (sv.lastError || 'unbekannt'), 'error');
          }
          renderScanV2();
          return;
        }
      }
    } finally {
      state.scanV2Polling = false;
    }
  }
  async function startScanV2(mode) {
    try {
      const label = SCAN_V2_MODE_LABEL[mode] || mode;
      status('Angebots-Scan 2.0 wird gestartet (' + label + ')…', 'info');
      await api('/api/offers/scan-v2/start', 'POST', { mode: mode });
      await loadScanV2();
      status('Angebots-Scan 2.0 läuft (' + label + '). Fortschritt in der Übersicht.', 'ok');
      pollScanV2().catch(() => {});
    } catch (error) {
      status((error && error.message) || 'Angebots-Scan 2.0 konnte nicht gestartet werden.', 'error');
      await loadScanV2().catch(() => {});
    }
  }
  async function cancelScanV2() {
    const btn = $('scan-v2-cancel-btn');
    if (btn) btn.disabled = true;
    try {
      await api('/api/offers/scan-v2/cancel', 'POST', {});
      status('Angebots-Scan 2.0 wird abgebrochen…', 'warn');
    } catch (error) {
      status((error && error.message) || 'Abbruch fehlgeschlagen.', 'error');
    } finally {
      if (btn) btn.disabled = false;
      await loadScanV2().catch(() => {});
    }
  }
  async function pauseScanV2() {
    const btn = $('scan-v2-pause-btn');
    if (btn) btn.disabled = true;
    try {
      await api('/api/offers/scan-v2/pause', 'POST', {});
      status('Angebots-Scan 2.0 wird pausiert — Fortschritt wird gesichert…', 'warn');
    } catch (error) {
      status((error && error.message) || 'Pause fehlgeschlagen.', 'error');
    } finally {
      if (btn) btn.disabled = false;
      await loadScanV2().catch(() => {});
    }
  }
  async function resumeScanV2() {
    const btn = $('scan-v2-resume-btn');
    if (btn) btn.disabled = true;
    try {
      await api('/api/offers/scan-v2/resume', 'POST', {});
      status('Angebots-Scan 2.0 wird fortgesetzt (ab Checkpoint)…', 'ok');
      await loadScanV2();
      pollScanV2().catch(() => {});
    } catch (error) {
      status((error && error.message) || 'Fortsetzen fehlgeschlagen.', 'error');
      await loadScanV2().catch(() => {});
    } finally {
      if (btn) btn.disabled = false;
    }
  }
  async function loadJobs() { state.jobs = await api('/api/admin/jobs'); renderAI(); renderNav(); }
  async function loadJobsHistory() { state.jobsHistory = await api('/api/admin/jobs/history'); renderAI(); }
  async function loadOllamaModels() { state.ollamaModels = await api('/api/admin/ollama/models'); renderAI(); renderOllamaModelOptions(); }
  async function loadOllamaConfig() { state.ollamaConfig = await api('/api/admin/ollama/config'); renderOllamaModelConfig(); }
  async function loadEnrichmentFlags() { state.enrichmentFlags = await api('/api/admin/enrichment-flags'); renderQuality(); }
  async function loadUserEvents() { state.userEvents = await api('/api/admin/users/events?limit=50'); renderUsers(); }
  async function loadSystem() {
    // /api/system/status antwortet in einer HUELLE: { system: {mobile, ollama, app},
    // ollamaRuntime, ollamaPull, ... }. renderSystem liest sys.mobile/sys.ollama/
    // sys.app — die liegen eine Ebene TIEFER. Ohne das Auspacken war jede Kachel
    // dauerhaft "gestoppt" und der Expo-QR-Code erschien nie, obwohl das Backend
    // mobileExpoUrl/mobileQrImageUrl korrekt gefuellt hatte.
    // Beide Formen werden akzeptiert, falls der Endpunkt spaeter flach antwortet.
    const payload = await api('/api/system/status');
    state.system = (payload && payload.system) ? payload.system : payload;
    renderSystem();
  }
  async function loadLogs() {
    const p = await api('/api/debug/logs?limit=300');
    state.logs = Array.isArray(p.logs) ? p.logs : [];
    renderOverviewFeed();
    renderSystemLogs();
  }

  // ---------- Renderers ----------
  function kpiCard(c) {
    const tone = c.tier || 'neutral';
    const value = c.value != null ? esc(c.value) : '–';
    const bar = c.bar != null
      ? '<div class="minibar ' + tone + '"><span style="width:' + Math.max(0, Math.min(100, c.bar)) + '%"></span></div>'
      : '<div class="kpi-sub">' + esc(c.sub || '') + '</div>';
    // Optional admin kill-switch (Nutrition/Halal/Allergene — enrichmentFlags.ts):
    // lets the admin hide a still-unreliable category from the app without
    // stopping the backend from computing it. c.toggle is only set for the
    // three categories this applies to (see renderQuality()).
    const toggle = c.toggle
      ? '<button type="button" class="kpi-toggle ' + (c.toggle.enabled ? 'on' : 'off') + '" ' +
        'data-action="enrichment-flag-toggle" data-category="' + esc(c.toggle.category) + '" ' +
        'title="' + esc(c.toggle.enabled ? 'In der App sichtbar — klicken zum Ausblenden' : 'In der App ausgeblendet — klicken zum Anzeigen') + '">' +
        (c.toggle.enabled ? 'an' : 'aus') +
      '</button>'
      : '';
    return '<div class="kpi">' +
      '<div class="kpi-label"><span class="dot ' + tone + '"></span>' + esc(c.label) + toggle + '</div>' +
      '<div class="kpi-value-row"><span class="kpi-value">' + value + '</span></div>' +
      bar +
    '</div>';
  }

  // ---------- Recipes (admin) ----------
  const RECIPE_FILTERS = [
    ['all', 'Alle'], ['active', 'Aktiv'], ['hidden', 'Versteckt'], ['ai', 'KI'],
    ['needsReview', 'Needs Review'], ['missingImage', 'Ohne Bild'], ['missingNutrition', 'Ohne Nährwerte'],
  ];
  function recipeMatchesFilter(r, f) {
    if (f === 'active') return r.status === 'active';
    if (f === 'hidden') return r.status === 'hidden';
    if (f === 'ai') return !!r.isAi;
    if (f === 'needsReview') return !!r.needsReview;
    if (f === 'missingImage') return !!r.missingImage;
    if (f === 'missingNutrition') return !!r.missingNutrition;
    return true;
  }
  // Group by the raw cuisine string (trimmed/lowercased). Recipes without a
  // cuisine fall into the '–' bucket so they stay reachable via a filter.
  function recipeCuisineKey(r) { return String(r.cuisine || '').trim().toLowerCase(); }
  function cuisineLabel(key) { return key ? key.charAt(0).toUpperCase() + key.slice(1) : 'Ohne Küche'; }
  function recipeMatchesCuisine(r, c) {
    if (c === 'all') return true;
    if (c === '__none__') return recipeCuisineKey(r) === '';
    return recipeCuisineKey(r) === c;
  }
  function badge(tone, label) { return '<span class="status-badge ' + tone + '">' + esc(label) + '</span>'; }
  function recipeRow(r) {
    const statusCell = r.status === 'active'
      ? badge('ok', 'aktiv')
      : '<span class="pill">' + esc(r.status === 'hidden' ? 'versteckt' : r.status) + '</span>';
    const srcTone = r.isAi ? 'warn' : (r.sourceType === 'public_domain_adapted' ? 'info' : 'ok');
    const srcLabel = r.isAi
      ? (r.sourceType === 'ai_adapted' ? 'KI angepasst' : 'KI')
      : (r.sourceType === 'public_domain_adapted' ? 'Public Domain' : (r.sourceType === 'human_verified' ? 'Human' : (r.sourceType || '–')));
    const revTone = r.verificationStatus === 'published' ? 'ok' : (r.verificationStatus === 'reviewed' ? 'info' : 'warn');
    const time = (r.cookTimeMinutes != null ? r.cookTimeMinutes + ' min' : '–') + (r.prepTimeMinutes != null ? ' (+' + r.prepTimeMinutes + ')' : '');
    const tags = [].concat((r.tags || []).slice(0, 3), (r.dietFlags || []).slice(0, 2));
    const tagsHtml = tags.length ? tags.map((t) => '<span class="pill">' + esc(t) + '</span>').join(' ') : '<span style="color:var(--muted)">–</span>';
    const warns = [];
    if (r.isAi) warns.push(badge('warn', 'KI + Hinweis'));
    if (r.missingSafetyNotes) warns.push(badge('crit', 'ohne Hinweis'));
    if (r.halalUnclear) warns.push(badge('warn', 'Halal?'));
    if (r.missingImage) warns.push('<span class="pill">kein Bild</span>');
    if (r.missingNutrition) warns.push('<span class="pill">keine Nährwerte</span>');
    if (r.needsReview) warns.push(badge('warn', 'Review'));
    const warnsHtml = warns.length ? warns.join(' ') : badge('ok', 'ok');
    const toggleTo = r.status === 'active' ? 'hidden' : 'active';
    const toggleLabel = r.status === 'active' ? 'Deaktivieren' : 'Aktivieren';
    const toggleCls = r.status === 'active' ? 'btn danger' : 'btn primary';
    const cuisineKey = recipeCuisineKey(r);
    const cuisineCell = cuisineKey
      ? badge('info', cuisineLabel(cuisineKey))
      : '<span style="color:var(--muted)">–</span>';
    return '<tr>' +
      '<td class="left bold">' + esc(r.title) +
        '<div style="color:var(--muted);font-size:11px;font-weight:400">' + (r.ingredientsCount || 0) + ' Zutaten · ' + (r.instructionsCount || 0) + ' Schritte</div></td>' +
      '<td class="left">' + statusCell + '</td>' +
      '<td class="left">' + badge(srcTone, srcLabel) + '</td>' +
      '<td class="left">' + badge(revTone, r.verificationStatus || '–') + '</td>' +
      '<td class="left">' + cuisineCell + '</td>' +
      '<td class="left">' + esc(r.mealType || '–') + '</td>' +
      '<td class="num">' + esc(time) + '</td>' +
      '<td class="left">' + tagsHtml + '</td>' +
      '<td class="left">' + warnsHtml + '</td>' +
      '<td class="left"><button class="' + toggleCls + '" data-action="recipe-status-toggle" data-id="' + esc(r.id) + '" data-status="' + toggleTo + '">' + toggleLabel + '</button></td>' +
    '</tr>';
  }
  function renderRecipes() {
    const data = state.recipes;
    const meta = $('recipes-meta');
    const banner = $('recipes-banner');
    const filterHost = $('recipes-filter');
    const cuisineHost = $('recipes-cuisine-filter');
    const tbody = document.querySelector('#recipes-table tbody');
    if (!tbody) return;
    if (!data) { if (meta) meta.textContent = 'Lade…'; return; }
    if (!data.available) {
      if (meta) meta.textContent = 'Supabase nicht konfiguriert';
      if (banner) banner.innerHTML = '<div class="status-bar" data-kind="warn" style="margin:0 0 10px">' +
        esc(data.error || 'Supabase nicht konfiguriert.') +
        ' Rezepte erscheinen, sobald SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY gesetzt sind.</div>';
      if (filterHost) filterHost.innerHTML = '';
      if (cuisineHost) cuisineHost.innerHTML = '';
      tbody.innerHTML = '<tr><td colspan="10" class="left"><div class="empty">Keine Rezepte (Supabase nicht verbunden).</div></td></tr>';
      return;
    }
    if (banner) banner.innerHTML = '';
    const all = data.recipes || [];
    const counts = {};
    for (const [id] of RECIPE_FILTERS) counts[id] = all.filter((r) => recipeMatchesFilter(r, id)).length;
    if (filterHost) {
      filterHost.innerHTML = RECIPE_FILTERS.map(([id, label]) =>
        '<button class="chip' + (state.recipesFilter === id ? ' active' : '') + '" data-rfilter="' + id + '">' +
        esc(label) + ' <span class="chip-count">' + (counts[id] || 0) + '</span></button>'
      ).join('');
    }
    // Cuisine chips: built dynamically from the cuisines actually present, with
    // per-cuisine counts. 'Alle' first, then by count desc; recipes without a
    // cuisine get a trailing 'Ohne Küche' bucket.
    if (cuisineHost) {
      const cuisineCounts = {};
      let noneCount = 0;
      for (const r of all) {
        const key = recipeCuisineKey(r);
        if (!key) { noneCount += 1; continue; }
        cuisineCounts[key] = (cuisineCounts[key] || 0) + 1;
      }
      const ordered = Object.keys(cuisineCounts).sort((a, b) => cuisineCounts[b] - cuisineCounts[a]);
      const chips = [['all', 'Alle', all.length]]
        .concat(ordered.map((key) => [key, cuisineLabel(key), cuisineCounts[key]]));
      if (noneCount > 0) chips.push(['__none__', 'Ohne Küche', noneCount]);
      cuisineHost.innerHTML = chips.map(([id, label, n]) =>
        '<button class="chip' + (state.recipesCuisine === id ? ' active' : '') + '" data-cfilter="' + esc(id) + '">' +
        esc(label) + ' <span class="chip-count">' + n + '</span></button>'
      ).join('');
    }
    const q = state.recipesSearch.trim().toLowerCase();
    const rows = all
      .filter((r) => recipeMatchesFilter(r, state.recipesFilter))
      .filter((r) => recipeMatchesCuisine(r, state.recipesCuisine))
      .filter((r) => !q || String(r.title || '').toLowerCase().includes(q));
    if (meta) meta.textContent = rows.length + ' / ' + all.length + ' Rezepte · ' +
      counts.active + ' aktiv · ' + counts.ai + ' KI · ' + counts.needsReview + ' Review';
    tbody.innerHTML = rows.length
      ? rows.map(recipeRow).join('')
      : '<tr><td colspan="10" class="left"><div class="empty">Keine Rezepte für diesen Filter.</div></td></tr>';
  }

  // ---------- Cheffity-Angebotsverbindung (deals ⇄ recipe ingredients) ----------
  function oqRow(title, sub) {
    return '<div style="padding:7px 0;border-bottom:1px solid var(--line-soft)">' +
      '<div style="font-size:12.5px;font-weight:600;color:var(--ink)">' + title + '</div>' +
      '<div style="font-size:11px;color:var(--muted)">' + (sub || '') + '</div>' +
    '</div>';
  }
  function setText(id, value) { const el = $(id); if (el) el.textContent = value; }
  function renderOfferQuality() {
    const d = state.offerQuality;
    if (!d) { setText('offer-quality-meta', 'Lade…'); return; }
    const k = d.kpis || {};
    const lm = d.lastRecipeMatch || {};
    const ls = d.lastSupabaseSync || {};
    setText('offer-quality-meta',
      'Matcher ' + (lm.status || 'never') + (lm.at ? ' · ' + fmtTime(lm.at) : '') +
      ' · letzter Sync ' + (ls.status || 'never') + (ls.at ? ' · ' + fmtTime(ls.at) : ''));

    const banner = $('offer-quality-banner');
    if (banner) {
      if (!d.supabaseConfigured) {
        banner.innerHTML = '<div class="status-bar" data-kind="warn" style="margin:0 0 10px">Supabase nicht konfiguriert — KPIs erscheinen, sobald SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY gesetzt sind.</div>';
      } else if (Array.isArray(d.warnings) && d.warnings.length) {
        banner.innerHTML = '<div class="status-bar" data-kind="info" style="margin:0 0 10px">' + d.warnings.map(esc).join(' · ') + '</div>';
      } else {
        banner.innerHTML = '';
      }
    }

    const cards = [
      { label: 'Aktuelle Angebote', value: fmtNumber(k.currentDeals), sub: 'gültig ab ≤ heute ≤ gültig bis', tier: 'neutral' },
      { label: 'Zukünftige Angebote', value: fmtNumber(k.futureDeals), sub: 'nächste Woche · nicht current', tier: k.futureDeals > 0 ? 'info' : 'neutral' },
      { label: 'Matchbare Angebote', value: fmtNumber(k.matchableDeals), sub: 'Food · Preis · gültig', tier: k.matchableDeals > 0 ? 'ok' : 'warn' },
      { label: 'Gültige Matches', value: fmtNumber(k.validDealMatches), sub: 'current · deal_recipe_matches', tier: k.validDealMatches > 0 ? 'ok' : 'warn' },
      { label: 'High-Confidence', value: fmtNumber(k.highConfidenceMatches), sub: 'auto · Score ≥ 0,85', tier: 'ok' },
      { label: 'Review Matches', value: fmtNumber(k.reviewMatches), sub: 'medium/low · prüfen', tier: k.reviewMatches > 0 ? 'info' : 'neutral' },
      { label: 'Verdächtige Matches', value: fmtNumber(k.suspiciousMatches), sub: 'False-Positive-Risiko', tier: k.suspiciousMatches > 0 ? 'crit' : 'ok' },
      { label: 'Rezepte mit Angeboten', value: fmtNumber(k.recipesWithValidDeals), bar: k.recipeCoveragePercent, tier: 'info' },
      { label: 'Zutaten mit Angeboten', value: fmtNumber(k.ingredientsWithValidDeals), bar: k.matchCoveragePercent, tier: 'info' },
      { label: 'Zukünftige Matches', value: fmtNumber(k.futureMatches), sub: 'nicht in current UI', tier: k.futureMatches > 0 ? 'warn' : 'ok' },
      { label: 'Abgelaufene Matches', value: fmtNumber(k.expiredMatches), sub: 'Deal abgelaufen', tier: k.expiredMatches > 0 ? 'warn' : 'ok' },
      { label: 'Low-Score Matches', value: fmtNumber(k.lowScoreMatches), sub: 'Review nötig', tier: k.lowScoreMatches > 0 ? 'warn' : 'ok' },
    ];
    const kpiHost = $('offer-quality-kpi');
    if (kpiHost) kpiHost.innerHTML = cards.map(kpiCard).join('');

    const deals = Array.isArray(d.topUnmatchedDeals) ? d.topUnmatchedDeals : [];
    const ings = Array.isArray(d.topUnmatchedIngredients) ? d.topUnmatchedIngredients : [];
    const rev = Array.isArray(d.reviewCandidates) ? d.reviewCandidates : [];
    const susp = Array.isArray(d.suspiciousMatches) ? d.suspiciousMatches : [];
    setText('oq-unmatched-deals-meta', deals.length + ' Stück');
    setText('oq-unmatched-ingredients-meta', ings.length + ' Stück');
    setText('oq-review-meta', rev.length + ' Stück');
    setText('oq-suspicious-meta', susp.length + ' Stück');

    const dealsHost = $('oq-unmatched-deals');
    if (dealsHost) dealsHost.innerHTML = deals.length
      ? deals.slice(0, 12).map((x) => oqRow(
          esc(x.name || ''),
          (x.storeName ? esc(x.storeName) + ' · ' : '') + fmtPrice(x.price) + (x.validTo ? ' · bis ' + esc(x.validTo) : ''),
        )).join('')
      : '<div class="empty">Alle matchbaren Angebote sind verbunden.</div>';

    const ingHost = $('oq-unmatched-ingredients');
    if (ingHost) ingHost.innerHTML = ings.length
      ? ings.slice(0, 12).map((x) => oqRow(
          esc(x.ingredientName || '') + (x.count > 1 ? ' ×' + x.count : ''),
          esc(x.recipeName || ''),
        )).join('')
      : '<div class="empty">Alle aktiven Zutaten haben ein Angebot.</div>';

    const revHost = $('oq-review');
    if (revHost) revHost.innerHTML = rev.length
      ? rev.slice(0, 12).map((x) => oqRow(
          esc(x.dealName || '') + ' → ' + esc(x.ingredientName || ''),
          'Score ' + (x.score != null ? Number(x.score).toFixed(2) : '–') + (x.recipeName ? ' · ' + esc(x.recipeName) : ''),
        )).join('')
      : '<div class="empty">Keine Low-Score-Matches.</div>';

    const suspReason = { derived_product: 'Derived-Produkt', no_head_noun: 'kein Head-Noun', no_ingredient_tokens: 'leere Zutat' };
    const suspHost = $('oq-suspicious');
    if (suspHost) suspHost.innerHTML = susp.length
      ? susp.slice(0, 12).map((x) => oqRow(
          esc(x.dealName || '') + ' → ' + esc(x.ingredientName || ''),
          (suspReason[x.reason] || x.reason || '?') + ' · Score ' + (x.score != null ? Number(x.score).toFixed(2) : '–') + (x.recipeName ? ' · ' + esc(x.recipeName) : ''),
        )).join('')
      : '<div class="empty">Keine verdächtigen Matches.</div>';
  }

  function renderOverview() {
    if (!state.overview) return;
    const k = state.overview.kpis;
    $('overview-meta').textContent = 'Snapshot ' + fmtDate(k.updatedAt) +
      ' · Ingest ' + (k.lastOffersRunStatus || '?') +
      ' · KI ' + (k.lastAiRunStatus || '?');

    const cards = [
      { label: 'Live-Angebote', value: fmtNumber(k.liveOffers), sub: 'aktive Woche', tier: k.liveOffers > 100 ? 'ok' : 'warn' },
      { label: 'Stores', value: fmtNumber(k.storeCount), sub: state.quality ? '1 evtl. low' : 'aktiv', tier: 'ok' },
      { label: 'Aktive Nutzer', value: fmtNumber(k.totalUsers), sub: k.totalUsers == null ? 'Supabase nicht konfig.' : 'gesamt', tier: k.totalUsers == null ? 'neutral' : 'ok' },
      { label: 'Aktive Abos', value: fmtNumber(k.activeSubscriptions), sub: k.activeSubscriptions == null ? '–' : 'status=active', tier: 'ok' },
      { label: 'Plus / Premium', value: (k.plusUsers ?? '–') + ' / ' + (k.premiumUsers ?? '–'), sub: 'Verteilung', tier: 'ok' },
      { label: 'Letzter KI-Lauf', value: fmtTime(k.lastAiRunAt), sub: k.lastAiRunStatus ? 'Status ' + k.lastAiRunStatus : '–', tier: statusTone(k.lastAiRunStatus) },
      { label: 'Letzter Sync', value: fmtTime(k.lastSupabaseSyncAt), sub: k.lastSupabaseSyncStatus || 'noch keiner', tier: statusTone(k.lastSupabaseSyncStatus) },
    ];
    $('overview-kpi').innerHTML = cards.map(kpiCard).join('');

    const warnings = state.overview.warnings || [];
    $('attn-count').textContent = warnings.length + ' offene Punkte';
    if (warnings.length === 0) {
      $('attn-list').innerHTML = '<div class="empty">Alles ruhig — keine Warnungen.</div>';
    } else {
      $('attn-list').innerHTML = warnings.map((w) => {
        const tier = w.level === 'error' ? 'crit' : 'warn';
        const ic = tier === 'crit' ? 'alertT' : 'alertC';
        return '<div class="attn ' + tier + '">' +
          '<span class="attn-ico">' + ico(ic, 13) + '</span>' +
          '<div class="attn-body">' +
            '<div class="attn-title">' + esc(w.message) + '</div>' +
            (w.detail ? '<div class="attn-desc">' + esc(w.detail) + '</div>' : '<div class="attn-desc">' + esc(w.code) + '</div>') +
          '</div>' +
          '<span></span>' +
        '</div>';
      }).join('');
    }

    const qa = [
      { icoKey: 'bolt', title: 'Angebots-Scan 1.0', desc: 'Voller Einzeldurchlauf: Scrape · Filter · KI', action: 'one-click-ai' },
      { icoKey: 'play', title: 'Mobile starten', desc: 'expo start', action: 'mobile-start' },
      { icoKey: 'cloud', title: 'Supabase Sync', desc: 'Live-Snapshot pushen', action: 'supabase-sync' },
      { icoKey: 'fileTxt', title: 'Logs öffnen', desc: 'Wechsel zu System & Logs', action: 'goto-system' },
    ];
    $('qa-grid').innerHTML = qa.map((q) =>
      '<button class="qa" data-action="' + esc(q.action) + '">' +
      '<span class="qa-ico">' + ico(q.icoKey, 14) + '</span>' +
      '<span>' +
        '<span class="qa-title">' + esc(q.title) + '</span>' +
        '<span class="qa-desc">' + esc(q.desc) + '</span>' +
      '</span>' +
      '<span></span>' +
      '</button>'
    ).join('');
  }

  function renderOverviewFeed() {
    const host = $('overview-feed');
    if (!host) return;
    const list = (state.logs || []).slice(-30).reverse();
    if (list.length === 0) {
      host.innerHTML = '<div class="empty">Keine Log-Events.</div>';
      return;
    }
    const tierFor = (lvl) => lvl === 'error' ? 'crit' : lvl === 'warn' ? 'warn' : 'info';
    host.innerHTML = list.map((e) => {
      const tag = String(e.message || '').split('.')[0] || 'log';
      return '<div class="feed-row">' +
        '<span class="dot ' + tierFor(e.level) + '"></span>' +
        '<span class="feed-time">' + esc(fmtTime(e.timestamp)) + '</span>' +
        '<span class="feed-msg">' + esc(e.message) + '</span>' +
        '<span class="feed-tag">' + esc(tag) + '</span>' +
      '</div>';
    }).join('');
  }

  // ---------- Offers ----------
  function offerProvenance(id) {
    if (!id) return 'pipeline';
    if (id.startsWith('official_')) return 'official';
    if (id.startsWith('local_')) return 'local_ocr';
    if (id.startsWith('rewe_browser_')) return 'rewe_import';
    return 'pipeline';
  }
  function miCellForOffer(o) {
    const hasNutrition = !!(o.nutrition && Object.values(o.nutrition).some((v) => v != null));
    const halalKnown = o.isHalal === true || o.isHalal === false;
    const hasAllergens = Array.isArray(o.allergens) && o.allergens.length > 0;
    // Anreicherung: vorhanden = grün, offen = neutral/grau (KEIN roter Fehler).
    const cls = (v) => v ? 'ok' : 'neutral';
    const tip = (v) => v ? '' : ' (offen)';
    return '<span class="meta-icons">' +
      '<span class="mi ' + cls(hasNutrition) + '" title="Nutrition' + tip(hasNutrition) + '">N</span>' +
      '<span class="mi ' + cls(halalKnown) + '" title="Halal' + tip(halalKnown) + '">H</span>' +
      '<span class="mi ' + cls(hasAllergens) + '" title="Allergene' + tip(hasAllergens) + '">A</span>' +
    '</span>';
  }
  function renderOffers() {
    // Lazy-loaded on the Angebote screen — guard against a render before the
    // (large) /api/offers payload has arrived.
    if (!state.offers) {
      const meta = $('offers-meta');
      if (meta) meta.textContent = 'Lade Angebote…';
      return;
    }
    $('offers-meta').textContent = fmtNumber(state.offers.live.length) + ' Live · ' +
      fmtNumber(state.offers.filtered.length) + ' Filtered · ' +
      fmtNumber(state.offers.next.length) + ' Next Week';
    $('offers-tab-live-count').textContent = fmtNumber(state.offers.live.length);
    $('offers-tab-filtered-count').textContent = fmtNumber(state.offers.filtered.length);
    $('offers-tab-next-count').textContent = fmtNumber(state.offers.next.length);
    document.querySelectorAll('#offers-tabs button').forEach((button) => {
      button.classList.toggle('active', button.dataset.tab === state.offerTab);
    });

    const list = state.offerTab === 'next' ? state.offers.next
              : state.offerTab === 'filtered' ? state.offers.filtered
              : state.offers.live;

    // Store filter
    const stores = Array.from(new Set(list.map((o) => o.storeChain || ''))).filter(Boolean).sort();
    $('store-filter').innerHTML = ['Alle', ...stores].map((s) =>
      '<button class="' + (state.storeFilter === (s === 'Alle' ? '' : s) ? 'active' : '') + '" data-store="' + esc(s === 'Alle' ? '' : s) + '">' + esc(s) + '</button>'
    ).join('');

    const q = state.offersSearch.toLowerCase();
    const visible = list.filter((o) => {
      if (state.storeFilter && o.storeChain !== state.storeFilter) return false;
      if (q) {
        const hay = ((o.name || '') + ' ' + (o.brand || '') + ' ' + (o.category || '') + ' ' + (o.storeChain || '')).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const tbody = document.querySelector('#offers-table tbody');
    if (visible.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10" class="left"><div class="empty">Keine Angebote für diesen Filter.</div></td></tr>';
      return;
    }
    const max = 200;
    const slice = visible.slice(0, max);
    tbody.innerHTML = slice.map((o) => {
      const selected = state.selectedOffers.has(o.id);
      const old = (o.originalPrice && o.originalPrice > o.price)
        ? '<span class="old">' + (Number(o.originalPrice).toFixed(2).replace('.', ',')) + ' €</span>'
        : '';
      const priceCell = o.price > 0
        ? '<span class="price-cell">' + old + (Number(o.price).toFixed(2).replace('.', ',')) + ' ' + esc(o.currency || 'EUR') + '</span>'
        : '<span style="color:var(--danger);font-weight:600">kein Preis</span>';
      const hasImage = !!(o.imageUrl && String(o.imageUrl).trim());
      const thumb = hasImage
        ? '<span class="thumb has-img" title="Produktbild"><img src="' + esc(o.imageUrl) + '" alt="" loading="lazy" referrerpolicy="no-referrer" /></span>'
        : '<span class="thumb no" title="kein Bild">' + ico('no_img', 14) + '</span>';
      const imageBadge = hasImage
        ? '<span class="status-badge ok"><span class="dot ok"></span>OK</span>'
        : '<span class="status-badge crit"><span class="dot crit"></span>fehlt</span>';
      const validTo = o.validityEnd ? fmtDate(o.validityEnd).split(',')[0] : '–';
      return '<tr>' +
        '<td class="left"><input type="checkbox" data-action="select-offer" data-id="' + esc(o.id) + '"' + (selected ? ' checked' : '') + ' /></td>' +
        '<td class="left">' +
          '<span class="name-cell">' + thumb +
          '<span class="name-text">' +
            '<span class="nm">' + esc(o.name || '(ohne Name)') + '</span>' +
            '<span class="sb">' + esc(o.brand || o.unit || '') + '</span>' +
          '</span></span>' +
        '</td>' +
        '<td class="left">' + storeLogo(o.storeChain) + '<span>' + esc(o.storeChain || '–') + '</span></td>' +
        '<td>' + priceCell + '</td>' +
        '<td class="left"><span class="pill">' + esc(o.category || '–') + '</span></td>' +
        '<td class="left" style="color:var(--muted)">' + esc(offerProvenance(o.id)) + '</td>' +
        '<td class="left">' + imageBadge + '</td>' +
        '<td class="left">' + miCellForOffer(o) + '</td>' +
        '<td class="left" style="color:var(--ink-2)">' + esc(validTo) + '</td>' +
        '<td class="left">' + (o.sourceUrl ? '<a class="btn ghost" href="' + esc(o.sourceUrl) + '" target="_blank" rel="noreferrer">Quelle →</a>' : '') + '</td>' +
      '</tr>';
    }).join('');
    if (visible.length > max) {
      tbody.innerHTML += '<tr><td colspan="10" class="left"><div class="empty">+' + (visible.length - max) + ' weitere — JSON-Download für die volle Liste.</div></td></tr>';
    }
  }

  // ---------- Quality ----------
  // Sortierung nach echtem Status-Tier (Backend) + App-Blockern. Anreicherung
  // (Nutrition/Halal/Allergene) fließt bewusst NICHT in die Reihenfolge ein.
  function criticalityScore(s) {
    const tier = (s.status && s.status.tier) || 'ok';
    let score = tier === 'crit' ? 100000 : tier === 'warn' ? 1000 : 0;
    if (s.lowOfferCount) score += 5000;
    const currentPrice = Number.isFinite(Number(s.withCurrentPricePercent)) ? s.withCurrentPricePercent : 100;
    score += (100 - currentPrice) * 3;
    score += (100 - (Number(s.withImagePercent) || 0)) * 2;
    score += (Number(s.withoutCategoryPercent) || 0) * 3;
    return score;
  }
  // Status kommt aus dem Backend (offersQuality.ts) — ehrlich + testbar.
  function storeStatusBadge(s) {
    const status = s.status || { tier: 'ok', reasons: [] };
    const reasons = Array.isArray(status.reasons) ? status.reasons : [];
    const title = reasons.map((r) => STORE_STATUS_REASON_LABEL[r] || r).join(' · ');
    if (status.tier === 'crit') return { tier: 'crit', label: 'Kritisch', title };
    if (status.tier === 'warn') {
      const onlyEnrichment = reasons.length > 0
        && reasons.every((r) => STORE_STATUS_ENRICHMENT_ONLY.has(r));
      return { tier: 'warn', label: onlyEnrichment ? 'Anreicherung offen' : 'Prüfen', title };
    }
    return { tier: 'ok', label: 'Gesund', title: title || 'keine offenen Punkte' };
  }
  // Ehrliche Produktinfo-Übersicht: zeigt analysiert/verifiziert/geschätzt/
  // Risiko/unklar statt irreführender 0-%-Coverage. "unklar" ist neutral (kein
  // roter Fehler) — nur offene Anreicherung/Review.
  function renderProductInfo(pi, liveTotal) {
    const host = $('quality-productinfo');
    if (!host) return;
    const meta = $('productinfo-meta');
    if (!pi) {
      if (meta) meta.textContent = '–';
      host.innerHTML = '<div class="empty">Noch keine Produktinfo-Analyse.</div>';
      return;
    }
    const total = liveTotal || pi.analyzedTotal || 0;
    if (meta) meta.textContent = fmtNumber(pi.analyzedTotal) + ' / ' + fmtNumber(total) + ' analysiert';
    const pctOf = (n) => (total > 0 ? ' · ' + fmtPct((Number(n) || 0) / total * 100) : '');
    const badge = (tone, label) => '<span class="status-badge ' + tone + '"><span class="dot ' + tone + '"></span>' + esc(label) + '</span>';
    const tile = (label, badges) =>
      '<div style="flex:1 1 160px;min-width:160px;border:1px solid var(--line);border-radius:10px;padding:10px 12px;background:var(--bg-a)">' +
        '<div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;font-weight:600">' + esc(label) + '</div>' +
        '<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:5px">' + badges.join('') + '</div>' +
      '</div>';

    const tiles = [];
    tiles.push(tile('Analysiert', [badge('ok', fmtNumber(pi.analyzedTotal) + pctOf(pi.analyzedTotal))]));
    tiles.push(tile('Nährwerte', [
      badge('ok', 'verifiziert ' + fmtNumber(pi.nutritionVerified)),
      badge('warn', 'geschätzt ' + fmtNumber(pi.nutritionEstimated)),
      badge('neutral', 'unklar ' + fmtNumber(pi.nutritionUnknown)),
    ]));
    tiles.push(tile('Halal', [
      badge('ok', 'halal ' + fmtNumber(pi.halalKnown - pi.halalNotHalal)),
      badge('neutral', 'nicht halal ' + fmtNumber(pi.halalNotHalal)),
      badge('warn', 'zweifelhaft ' + fmtNumber(pi.halalDoubtful)),
      badge('neutral', 'unklar ' + fmtNumber(pi.halalUnknown)),
    ]));
    tiles.push(tile('Allergene', [
      badge('ok', 'bekannt ' + fmtNumber(pi.allergenKnown)),
      badge('warn', 'Risiko ' + fmtNumber(pi.allergenRisk)),
      badge('neutral', 'unklar ' + fmtNumber(pi.allergenUnknown)),
    ]));
    tiles.push(tile('Alkohol erkannt', [badge('info', fmtNumber(pi.alcoholDetected) + pctOf(pi.alcoholDetected))]));
    tiles.push(tile('Vegan / Vegetarisch', [
      badge(pi.veganCount > 0 ? 'ok' : 'neutral', 'vegan ' + fmtNumber(pi.veganCount)),
      badge(pi.vegetarianCount > 0 ? 'ok' : 'neutral', 'veg. ' + fmtNumber(pi.vegetarianCount)),
    ]));
    host.innerHTML = tiles.join('');
  }

  function renderQuality() {
    if (!state.quality) return;
    const r = state.quality;
    const k = r.kpis || {};
    $('quality-meta').textContent = 'Snapshot ' + fmtDate(k.updatedAt) + ' · berechnet vor ' + fmtRelative(r.generatedAt);

    const cards = [
      { label: 'Live-Angebote', value: fmtNumber(k.liveTotal), sub: 'aktive Woche', tier: 'ok' },
      { label: 'Stores', value: fmtNumber(k.storeCount), sub: '–', tier: 'ok' },
      { label: 'Bild', value: fmtPct(k.imageCoveragePercent), bar: k.imageCoveragePercent, tier: tierHigh(k.imageCoveragePercent, 80, 50) },
      { label: 'Nutrition', value: fmtPct(k.nutritionCoveragePercent), bar: k.nutritionCoveragePercent, tier: tierSoft(k.nutritionCoveragePercent, 60), sub: 'Anreicherung offen', toggle: { category: 'nutrition', enabled: state.enrichmentFlags?.flags?.nutrition !== false } },
      { label: 'Halal', value: fmtPct(k.halalCoveragePercent), bar: k.halalCoveragePercent, tier: tierSoft(k.halalCoveragePercent, 60), sub: 'Anreicherung offen', toggle: { category: 'halal', enabled: state.enrichmentFlags?.flags?.halal !== false } },
      { label: 'Allergene', value: fmtPct(k.allergensCoveragePercent), bar: k.allergensCoveragePercent, tier: tierSoft(k.allergensCoveragePercent, 50), sub: 'Anreicherung offen', toggle: { category: 'allergens', enabled: state.enrichmentFlags?.flags?.allergens !== false } },
      { label: 'Aktualisiert', value: fmtTime(k.updatedAt), sub: 'vor ' + fmtRelative(k.updatedAt), tier: 'ok' },
    ];
    $('quality-kpi').innerHTML = cards.map(kpiCard).join('');

    renderProductInfo(r.productInfo, k.liveTotal);

    const stores = [...(r.stores || [])].sort((a, b) => criticalityScore(b) - criticalityScore(a));
    $('quality-store-meta').textContent = stores.length + ' Stores';
    const tbody = document.querySelector('#quality-store-table tbody');
    if (stores.length === 0) {
      tbody.innerHTML = '<tr><td colspan="13"><div class="empty">Keine Stores.</div></td></tr>';
    } else {
      tbody.innerHTML = stores.map((s) => {
        const st = storeStatusBadge(s);
        const lowPill = s.lowOfferCount ? '<span class="low-pill">⚠ low</span>' : '';
        const currentPrice = Number.isFinite(Number(s.withCurrentPricePercent)) ? s.withCurrentPricePercent : 100;
        // Ehrliche Bildqualität: "Bild" = URL vorhanden; "Erreichbar"/"Broken" nur
        // gefüllt, wenn der Phase-1-Bildcheck (Scan 2.0) tatsächlich lief.
        const imgChecked = Number(s.imageChecked) || 0;
        const brokenCount = Number(s.brokenImage) || 0;
        const reachCell = imgChecked > 0
          ? pctCell(s.withReachableImagePercent, { okAt: 85, warnAt: 60 })
          : '<td class="num" style="color:var(--muted)" title="Noch kein Bildcheck (Scan 2.0 Phase 1)">–</td>';
        const brokenCell = imgChecked > 0
          ? '<td class="num"' + (brokenCount > 0 ? ' style="color:var(--danger)"' : '') + ' title="' + esc(brokenCount + ' broken von ' + imgChecked + ' geprüft') + '">' + brokenCount + '</td>'
          : '<td class="num" style="color:var(--muted)" title="Noch kein Bildcheck (Scan 2.0 Phase 1)">–</td>';
        return '<tr class="' + (s.lowOfferCount ? 'low-store' : '') + '">' +
          '<td class="left bold">' + storeLogo(s.storeChain) + '<span>' + esc(s.storeChain) + '</span>' + lowPill + '</td>' +
          '<td class="num">' + s.total + '</td>' +
          pctCell(s.withImagePercent, { okAt: 85, warnAt: 60 }) +
          reachCell +
          brokenCell +
          // Akt. Preis = echter Blocker -> hart
          pctCell(currentPrice, { okAt: 95, warnAt: 80 }) +
          // Streichpreis/Rabatt/Nutrition/Allergene/Halal = Anreicherung -> nie rot
          pctCell(s.withOriginalPricePercent, { soft: true, okAt: 70 }) +
          pctCell(s.withSavingsPercentPercent, { soft: true, okAt: 70 }) +
          pctCell(s.withNutritionPercent, { soft: true, okAt: 55 }) +
          pctCell(s.withAllergensPercent, { soft: true, okAt: 50 }) +
          pctCell(s.halalKnownPercent, { soft: true, okAt: 50 }) +
          pctCell(s.withoutCategoryPercent, { invert: true, okAt: 6, warnAt: 15 }) +
          '<td class="left"><span class="status-badge ' + st.tier + '"' + (st.title ? ' title="' + esc(st.title) + '"' : '') + '><span class="dot ' + st.tier + '"></span>' + esc(st.label) + '</span></td>' +
        '</tr>';
      }).join('');
    }

    // Review filter chips
    const counts = r.reviewCounts || {};
    const total = (r.review || []).length;
    const order = ['no_image','no_price','no_category','category_other','no_nutrition','halal_unknown','allergens_empty_risk','alcohol_unknown_risk'];
    const chips = ['<button class="chip ' + (state.qualityFilter === 'all' ? 'active' : '') + '" data-filter="all">Alle <span class="chip-count">' + total + '</span></button>']
      .concat(order.filter((r) => (counts[r] || 0) > 0).map((reason) =>
        '<button class="chip ' + (state.qualityFilter === reason ? 'active' : '') + '" data-filter="' + esc(reason) + '">' +
          esc(REVIEW_REASON_LABEL[reason]) + ' <span class="chip-count">' + counts[reason] + '</span>' +
        '</button>'
      ));
    $('review-filter').innerHTML = chips.join('');

    const items = state.qualityFilter === 'all'
      ? (r.review || [])
      : (r.review || []).filter((i) => (i.reasons || []).includes(state.qualityFilter));
    $('review-meta').textContent = items.length + ' / ' + total + ' Items';
    if (items.length === 0) {
      $('review-list').innerHTML = '<div class="empty">Keine Angebote für diesen Filter.</div>';
      return;
    }
    const max = 100;
    $('review-list').innerHTML = items.slice(0, max).map((it) => {
      const price = Number(it.price) > 0
        ? Number(it.price).toFixed(2).replace('.', ',') + ' €'
        : '<span style="color:var(--danger)">kein Preis</span>';
      const tags = (it.reasons || []).map((r) => {
        const cls = HARD_REASONS.has(r) ? 'hard' : 'risk';
        return '<span class="reason-tag ' + cls + '">' + esc(REVIEW_REASON_LABEL[r] || r) + '</span>';
      }).join('');
      return '<div class="review-item">' +
        '<div class="review-top">' +
          '<div class="review-name">' + esc(it.name || '(ohne Name)') + '</div>' +
          '<div class="review-meta">' +
            '<span>' + esc(it.storeChain || '–') + '</span>' +
            '<span class="dotmini"></span>' +
            '<span>' + esc(it.category || '–') + '</span>' +
            '<span class="dotmini"></span>' +
            '<span>' + price + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="review-tags">' + tags + '</div>' +
        (it.sourceUrl ? '<div class="review-foot" style="display:flex;justify-content:flex-end"><a href="' + esc(it.sourceUrl) + '" target="_blank" rel="noreferrer">Quelle öffnen ↗</a></div>' : '') +
      '</div>';
    }).join('') + (items.length > max ? '<div class="empty">+' + (items.length - max) + ' weitere — JSON-Download für die volle Liste.</div>' : '');

    renderQualityStoreScope();
    renderQualityAiStatus();
    // Keep the button label in sync with the current scope selection (unless a
    // run is active — then the poll loop owns the button text/progress).
    if (!state.qualityAiRunning) {
      setQualityAiButton(false);
    }
  }

  // ---------- Quality · KI prüfen & verbessern ----------
  // Startet den BESTEHENDEN KI-Rescan (rescan-food-ai) aus der Datenqualität
  // heraus und verfolgt seinen echten Status. Keine eigene KI-Logik, kein
  // gefälschter 100%-Status — alles kommt aus /api/offers/rescan-food-ai/status.

  // Mappt einen (ggf. lowercased) Store-Chain-Namen zurück auf die Anzeige-
  // Schreibweise aus state.quality.stores.
  function displayChain(chain) {
    const stores = (state.quality && state.quality.stores) || [];
    const hit = stores.find((s) => String(s.storeChain).toLowerCase() === String(chain).toLowerCase());
    return hit ? hit.storeChain : chain;
  }
  // Kurzes Scope-Label: „Alle Stores“ / „REWE“ / „REWE + Lidl“ / „REWE + 2 weitere“.
  function scopeLabelFromChains(chains) {
    if (!chains || chains.length === 0) return 'Alle Stores';
    const names = chains.map(displayChain);
    if (names.length === 1) return names[0];
    if (names.length === 2) return names[0] + ' + ' + names[1];
    return names[0] + ' + ' + (names.length - 1) + ' weitere';
  }
  // Bevorzugt den serverseitigen Scope (läuft evtl. von woanders), sonst die
  // lokale Auswahl.
  function activeScopeChains(r) {
    if (r && r.scopeType === 'stores' && Array.isArray(r.storeChains) && r.storeChains.length) {
      return r.storeChains;
    }
    if (r && r.scopeType === 'all') return [];
    return state.qualityStoreScope || [];
  }

  function renderQualityStoreScope() {
    const host = $('quality-store-scope-chips');
    if (!host) return;
    const stores = [...((state.quality && state.quality.stores) || [])]
      .filter((s) => s && s.storeChain)
      .sort((a, b) => (b.total || 0) - (a.total || 0));
    const sel = state.qualityStoreScope || [];
    const selSet = new Set(sel.map((c) => String(c).toLowerCase()));
    const running = !!state.qualityAiRunning;
    const dis = running ? ' disabled' : '';
    const allActive = sel.length === 0;
    const chips = ['<button class="chip ' + (allActive ? 'active' : '') + '" data-scope-store="__all__"' + dis + '>Alle Stores</button>']
      .concat(stores.map((s) => {
        const active = selSet.has(String(s.storeChain).toLowerCase());
        return '<button class="chip ' + (active ? 'active' : '') + '" data-scope-store="' + esc(s.storeChain) + '"' + dis + '>' +
          esc(s.storeChain) + ' <span class="chip-count">' + (s.total || 0) + '</span></button>';
      }));
    host.innerHTML = chips.join('');
  }

  // Toggle eines Store-Chips. „Alle Stores“ leert die Auswahl; Einzelauswahl
  // entfernt „Alle“. Wird alles wieder abgewählt, gilt erneut „alle“.
  function toggleStoreScope(storeChain) {
    if (state.qualityAiRunning) return;
    if (storeChain === '__all__') {
      state.qualityStoreScope = [];
    } else {
      const sel = state.qualityStoreScope || [];
      const idx = sel.findIndex((c) => String(c).toLowerCase() === String(storeChain).toLowerCase());
      if (idx >= 0) state.qualityStoreScope = sel.filter((_, i) => i !== idx);
      else state.qualityStoreScope = [...sel, storeChain];
    }
    renderQualityStoreScope();
    setQualityAiButton(state.qualityAiRunning, state.qualityAiStatus && state.qualityAiStatus.processed, state.qualityAiStatus && state.qualityAiStatus.total);
  }

  function aiRunStatusLabel(r) {
    if (!r) return 'idle';
    if (r.running) return 'läuft';
    if (r.lastError) return 'Fehler';
    if (r.finishedAt) return 'fertig';
    return 'idle';
  }
  // A finished KI run is a FAILURE (red) when it errored, OR when KI was on but
  // produced 0 classifications (pure rule fallback) — never show that as green.
  function aiRunFailed(r) {
    if (!r || r.running) return false;
    if (r.lastError) return true;
    if (Number(r.scannedCount) > 0 && Number(r.aiClassifiedCount) === 0) return true;
    return false;
  }
  function renderQualityAiStatus() {
    const host = $('quality-ai-status');
    if (!host) return;
    const r = state.qualityAiStatus;
    const model = (state.ollamaConfig && state.ollamaConfig.model) || 'qwen3:14b';
    if (!r) {
      host.style.color = '';
      host.textContent = 'Letzter KI-Lauf: – · Modell: ' + model;
      return;
    }
    const when = r.running
      ? 'läuft gerade'
      : (r.finishedAt ? 'vor ' + fmtRelative(r.finishedAt) : (r.startedAt ? 'gestartet' : 'noch keiner'));
    const scopeLabel = scopeLabelFromChains(activeScopeChains(r));
    const failed = aiRunFailed(r);
    const modeLabel = r.mode === 'missing_or_uncertain' ? 'Inkrementell' : 'Vollscan';
    // Scope · mode · progress (while running) · KI successes · fallback · error.
    let detail = ' · Modus: ' + esc(modeLabel) + ' · Scope: ' + esc(scopeLabel);
    if (r.running && Number(r.total) > 0) {
      detail += ' · ' + fmtNumber(r.processed) + '/' + fmtNumber(r.total);
      const eta = state.qualityAiEta;
      if (eta && Number.isFinite(eta.etaSeconds) && eta.etaSeconds > 0) {
        detail += ' · ETA ~' + fmtDuration(eta.etaSeconds * 1000);
      }
    }
    // Incremental metrics. Be HONEST: "an Modell gesendet" (attempted) is kept
    // separate from "per KI" (classifiedByAi). Never claim KI success on fallback.
    if (r.selective) {
      const s = r.selective;
      detail += ' · ' + fmtNumber(s.sentToModel) + ' an Modell';
      if (!r.running) {
        detail += ' (' + fmtNumber(s.classifiedByAi) + ' per KI, ' + fmtNumber(s.fallbackOnly) + ' Fallback)';
      }
      detail += ' · ' + fmtNumber(s.reusedProductAnalysis) + ' aus Produkt-Cache · ' +
        fmtNumber(s.skippedUpToDate) + ' aktuell · ' + fmtNumber(s.skippedLocked) + ' gesperrt';
      // KI-Timeouts: einzelne langsame Produkte, die übersprungen wurden (Review).
      if (Number(s.timedOutItems) > 0) {
        detail += ' · ⏱ ' + fmtNumber(s.timedOutItems) + ' Timeout';
        if (Number(s.reviewNeededFromTimeout) > 0) detail += ' (' + fmtNumber(s.reviewNeededFromTimeout) + ' Review)';
        if (s.lastTimedOutOfferName) detail += ' — zuletzt: ' + esc(String(s.lastTimedOutOfferName));
      }
      // Kategorie-Konflikte: korrigiert + zur Review markiert (keine echte KI).
      if (Number(s.conflictRejected) > 0) detail += ' · ⚑ ' + fmtNumber(s.conflictRejected) + ' Konflikt korrigiert';
      if (Number(s.uncertainRemaining) > 0) detail += ' · ' + fmtNumber(s.uncertainRemaining) + ' offen';
    } else if (!r.running && r.finishedAt && Number(r.scannedCount) > 0) {
      detail += ' · ' + fmtNumber(r.aiClassifiedCount) + ' per KI · ' + fmtNumber(r.fallbackCount) + ' per Regeln';
    }
    if (!r.running && r.finishedAt && Number(r.durationMs) > 0) {
      detail += ' · Dauer ' + fmtDuration(r.durationMs);
    }
    // fallbackOnly: tried the model but got 0 real KI hits → warn, never "ok".
    const fallbackOnly = !r.running && r.finishedAt && Number(r.scannedCount) > 0 && Number(r.aiClassifiedCount) === 0;
    const statusText = failed ? 'fehlgeschlagen' : aiRunStatusLabel(r);
    let errPart = '';
    if (!r.running && r.lastError) errPart = ' · ' + esc(r.lastError);
    else if (fallbackOnly) errPart = ' · NUR Fallback/Regeln — keine echte KI-Klassifizierung (Ollama prüfen, Snapshot NICHT als verbessert werten)';
    // Preflight heads-up (e.g. smoke soft-pass) shown even on an otherwise-ok run.
    if (r.preflightWarning) errPart += ' · ⚠ ' + esc(r.preflightWarning);
    host.style.color = (failed || fallbackOnly) ? 'var(--danger)' : (r.preflightWarning ? 'var(--warn, #b45309)' : '');
    host.innerHTML = 'Letzter KI-Lauf: ' + esc(when) +
      ' · Modell: ' + esc(model) +
      ' · Status: ' + esc(statusText) + detail + errPart;
  }
  // Small "ms → 1m 23s" formatter for durations/ETAs.
  function fmtDuration(ms) {
    const totalSec = Math.max(0, Math.round(Number(ms) / 1000));
    if (totalSec < 60) return totalSec + 's';
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    if (m < 60) return m + 'm' + (s ? ' ' + s + 's' : '');
    const h = Math.floor(m / 60);
    return h + 'h ' + (m % 60) + 'm';
  }
  // Ollama availability label from the runtime snapshot in /status.
  function ollamaRuntimeLabel(rt) {
    if (!rt) return '';
    if (rt.source === 'managed') return 'Ollama: läuft (managed)';
    if (rt.source === 'external') return 'Ollama: läuft extern';
    return 'Ollama: nicht erreichbar';
  }
  // Side-by-side comparison KPIs: last full vs. last incremental run. Only GENUINE
  // KI completions are recorded server-side (fallback-only runs abort and are not
  // counted), so this line never shows a non-KI run as a KI run.
  function renderQualityAiCompare() {
    const host = $('quality-ai-compare');
    if (!host) return;
    const cmp = state.qualityAiComparison;
    const rtLabel = ollamaRuntimeLabel(state.qualityOllamaRuntime);
    const parts = [];
    if (cmp && cmp.all) {
      parts.push('Letzter Vollscan: ' + fmtDuration(cmp.all.durationMs) + ' · ' +
        fmtNumber(cmp.all.scannedCount) + ' Items · ' + fmtNumber(cmp.all.aiClassifiedCount) + ' per KI');
    }
    if (cmp && cmp.missing_or_uncertain) {
      const m = cmp.missing_or_uncertain;
      parts.push('Letzter neuer Scan: ' + fmtDuration(m.durationMs) + ' · ' +
        fmtNumber(m.sentToModel) + ' an Modell (' + fmtNumber(m.classifiedByAi) + ' per KI) · ' +
        fmtNumber(m.reusedProductAnalysis) + ' Cache-Reuse · ' + fmtNumber(m.skipped) + ' übersprungen');
    }
    const left = rtLabel ? [rtLabel] : [];
    host.textContent = left.concat(parts).join('  |  ');
  }
  // Show/hide the "KI-Lauf abbrechen" button alongside the run button.
  function setQualityAiCancelVisible(running) {
    const cancel = $('quality-ai-cancel-btn');
    if (cancel) cancel.style.display = running ? '' : 'none';
  }
  function setQualityAiButton(running, processed, total) {
    setQualityAiCancelVisible(!!running);
    // The incremental button is only enabled when idle; while a run is active it
    // is disabled so the two modes can never overlap.
    const incBtn = $('quality-ai-btn-incremental');
    if (incBtn) {
      incBtn.disabled = !!running;
      const incScope = running ? '' : ' (' + esc(scopeLabelFromChains(state.qualityStoreScope)) + ')';
      incBtn.innerHTML = ico('refresh', 14) + 'Nur neue/unklare prüfen' + incScope;
    }
    const btn = $('quality-ai-btn');
    if (!btn) return;
    btn.disabled = !!running;
    if (running) {
      // Running → reflect the scope + mode the active run is actually processing.
      const r = state.qualityAiStatus || {};
      const scopeLabel = scopeLabelFromChains(activeScopeChains(r));
      const modeLabel = r.mode === 'missing_or_uncertain' ? 'Inkrementell' : 'Vollscan';
      const prog = Number(total) > 0 ? ' · ' + fmtNumber(processed) + '/' + fmtNumber(total) : '';
      btn.innerHTML = ico('bolt', 14) + 'KI läuft (' + modeLabel + '): ' + esc(scopeLabel) + prog;
    } else {
      // Idle → reflect the user's current selection so they see what will run.
      const scopeLabel = scopeLabelFromChains(state.qualityStoreScope);
      btn.innerHTML = ico('bolt', 14) + 'Alles neu mit KI: ' + esc(scopeLabel);
    }
  }
  // Lädt den aktuellen Rescan-Status (+ Modell-Config) für die Statuszeile.
  // Hängt sich an einen bereits laufenden Lauf an, falls anderswo gestartet.
  async function loadQualityAiStatus() {
    try {
      if (!state.ollamaConfig) await loadOllamaConfig().catch(() => {});
      const st = await api('/api/offers/rescan-food-ai/status');
      state.qualityAiStatus = st.aiRescan || null;
      state.qualityAiComparison = st.aiRescanComparison || null;
      state.qualityAiEta = st.aiRescanEta || null;
      state.qualityOllamaRuntime = st.ollamaRuntime || null;
      const r = state.qualityAiStatus;
      setQualityAiButton(r && r.running, r && r.processed, r && r.total);
      renderQualityAiStatus();
      renderQualityAiCompare();
      if (r && r.running && !state.qualityAiRunning) {
        pollQualityAi(r.finishedAt || null).catch(() => {});
      }
    } catch {}
  }
  function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }
  // Pollt den echten Status bis der Lauf nicht mehr läuft. baselineFinishedAt =
  // finishedAt VOR dem Start, damit ein neuer Abschluss sicher erkannt wird
  // (auch wenn der erste Poll den Lauf noch nicht als running gesehen hat).
  async function pollQualityAi(baselineFinishedAt) {
    state.qualityAiRunning = true;
    let sawRunning = false;
    for (let i = 0; i < 800; i++) {
      await sleep(1500);
      let st;
      try { st = await api('/api/offers/rescan-food-ai/status'); }
      catch { continue; }
      const r = st.aiRescan || {};
      state.qualityAiStatus = r;
      state.qualityAiComparison = st.aiRescanComparison || state.qualityAiComparison || null;
      state.qualityAiEta = st.aiRescanEta || null;
      state.qualityOllamaRuntime = st.ollamaRuntime || state.qualityOllamaRuntime || null;
      if (r.running) sawRunning = true;
      setQualityAiButton(r.running, r.processed, r.total);
      renderQualityAiStatus();
      renderQualityAiCompare();
      if (r.running) {
        const modeLabel = r.mode === 'missing_or_uncertain' ? 'KI inkrementell' : 'KI Vollscan';
        const scopeLabel = scopeLabelFromChains(activeScopeChains(r));
        status(modeLabel + ' läuft: ' + scopeLabel + (Number(r.total) > 0 ? ' · ' + fmtNumber(r.processed) + '/' + fmtNumber(r.total) : ' · analysiere Angebote'), 'info');
        continue;
      }
      const finishedChanged = r.finishedAt && r.finishedAt !== baselineFinishedAt;
      if (sawRunning || finishedChanged) {
        const scopeLabel = scopeLabelFromChains(activeScopeChains(r));
        state.qualityAiRunning = false;
        // Re-enable the scope chips now that the run is done.
        renderQualityStoreScope();
        setQualityAiButton(false);
        if (r.lastError) {
          renderQualityAiStatus();
          status('KI-Lauf mit Fehler beendet (' + scopeLabel + '): ' + r.lastError, 'error');
        } else {
          await Promise.all([loadQuality(), loadOffers(), loadOverview()]).catch(() => {});
          renderQualityAiStatus();
          status('KI-Lauf fertig für ' + scopeLabel + ': ' + fmtNumber(r.aiClassifiedCount) + ' per KI · ' +
            fmtNumber(r.fallbackCount) + ' per Regeln. Datenqualität neu geladen.', 'ok');
        }
        return;
      }
      // Weder läuft noch fertig erkennbar → kurze Startphase, weiter warten.
    }
    state.qualityAiRunning = false;
    setQualityAiButton(false);
    status('KI-Lauf: Zeitlimit beim Verfolgen erreicht. Status bitte manuell prüfen.', 'warn');
  }
  async function runQualityAiImprove(mode) {
    if (state.qualityAiRunning) return;
    const scanMode = mode === 'missing_or_uncertain' ? 'missing_or_uncertain' : 'all';
    const isIncremental = scanMode === 'missing_or_uncertain';
    let baseline = null;
    let runtime = null;
    try {
      const pre = await api('/api/offers/rescan-food-ai/status');
      baseline = (pre.aiRescan && pre.aiRescan.finishedAt) || null;
      runtime = pre.ollamaRuntime || null;
      state.qualityOllamaRuntime = runtime;
      renderQualityAiCompare();
      if (pre.aiRescan && pre.aiRescan.running) {
        state.qualityAiStatus = pre.aiRescan;
        setQualityAiButton(true, pre.aiRescan.processed, pre.aiRescan.total);
        status('KI-Lauf läuft bereits — Fortschritt wird verfolgt…', 'info');
        await pollQualityAi(baseline);
        return;
      }
    } catch {}
    // Up-front Ollama availability so the user knows what they're starting on.
    if (runtime && runtime.source === 'unavailable') {
      if (!confirm('Ollama ist aktuell nicht erreichbar unter ' + (runtime.host || 'localhost:11434') +
        '.\\n\\nDer Backend-Preflight versucht es zu starten; läuft Ollama extern, bitte sicherstellen, dass es erreichbar ist.\\n\\nTrotzdem fortfahren?')) {
        status('KI-Lauf abgebrochen — Ollama nicht erreichbar.', 'warn');
        return;
      }
    }
    const storeChains = (state.qualityStoreScope || []).slice();
    const scopeLabel = scopeLabelFromChains(storeChains);
    state.qualityAiRunning = true;
    state.qualityAiMode = scanMode;
    // Lock the scope chips while a run is active.
    renderQualityStoreScope();
    setQualityAiButton(true, 0, 0);
    const rtNote = runtime ? ' · ' + ollamaRuntimeLabel(runtime) : '';
    status(
      (isIncremental
        ? 'Inkrementeller KI-Scan gestartet (' + scopeLabel + ')… prüft nur fehlende/unsichere Produktdaten.'
        : 'KI-Vollscan gestartet (' + scopeLabel + ')… ALLE Angebote werden neu geprüft.') + rtNote,
      'info',
    );
    try {
      // storeChains nur senden, wenn etwas gewählt ist — leer = alle Stores (alt).
      const body = { tryOllama: true, mode: scanMode };
      if (storeChains.length > 0) body.storeChains = storeChains;
      try {
        await api('/api/offers/rescan-food-ai/start', 'POST', body);
      } catch (err) {
        // All-stores guard (409): too many offers would hit the model. The full
        // scan shows a hard warning; the incremental path only a short note.
        const msg = (err && err.message) || '';
        if (storeChains.length === 0 && /forceAll/i.test(msg)) {
          const prompt = isIncremental
            ? 'Erststart/viele neue Produkte — der inkrementelle Scan würde diesmal viele Angebote prüfen.\\n\\n' + msg + '\\n\\nTrotzdem starten?'
            : 'Großer KI-Vollscan über ALLE Stores.\\n\\n' + msg + '\\n\\nTrotzdem starten?';
          if (!confirm(prompt)) {
            throw new Error('Abgebrochen — bitte einen oder mehrere Stores im KI-Scope wählen.');
          }
          await api('/api/offers/rescan-food-ai/start', 'POST', { ...body, forceAll: true });
        } else {
          throw err;
        }
      }
      await pollQualityAi(baseline);
    } catch (error) {
      state.qualityAiRunning = false;
      renderQualityStoreScope();
      setQualityAiButton(false);
      renderQualityAiStatus();
      // Clearer message for the smoke-timeout case (Ollama up, model still loading).
      let msg = (error && error.message) || 'KI-Lauf konnte nicht gestartet werden.';
      if (/smoke|zeitlimit|timeout/i.test(msg)) {
        msg = 'Ollama erreichbar, aber Smoke-Test Timeout — ' + (state.ollamaConfig && state.ollamaConfig.model || 'qwen3') +
          ' lädt evtl. noch. Kurz warten und erneut versuchen. (' + msg + ')';
      }
      status(msg, 'error');
    }
  }

  // Hard cancel of the running KI-Rescan — kills the Python child server-side.
  async function cancelQualityAi() {
    const btn = $('quality-ai-cancel-btn');
    if (btn) btn.disabled = true;
    try {
      await api('/api/offers/rescan-food-ai/cancel', 'POST', {});
      status('KI-Lauf wird abgebrochen… Der Python-Prozess wird beendet.', 'warn');
    } catch (error) {
      status((error && error.message) || 'Abbruch fehlgeschlagen.', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ---------- Trends ----------
  function rankList(items, key) {
    if (!items || items.length === 0) {
      return '<div class="empty">Noch keine Trenddaten.</div>';
    }
    const max = Math.max(...items.map((i) => Number(i[key]) || 0)) || 1;
    return items.slice(0, 8).map((it, i) => {
      const count = Number(it[key]) || 0;
      const width = Math.round((count / max) * 100);
      return '<div class="rank-row ' + (i === 0 ? 'r1' : '') + '">' +
        '<span class="rnk">#' + (i + 1) + '</span>' +
        '<span class="nm">' + esc(it.displayName || it.nameDe || it.nameKey || '–') + '</span>' +
        '<span class="bar"><span style="width:' + width + '%"></span></span>' +
        '<span class="ct">' + fmtNumber(count) + '</span>' +
      '</div>';
    }).join('');
  }

  // ---------- Offer History ----------
  function renderHistory() {
    const banner = $('history-banner');
    const meta = $('history-meta');
    const kpiHost = $('history-kpi');
    if (!kpiHost) return;
    renderHistoryWeeks();
    renderHistoryWeekDetail();
    const h = state.history;
    if (!h) {
      if (meta) meta.textContent = 'Lade…';
      kpiHost.innerHTML = '';
      return;
    }
    if (!h.available) {
      if (banner) banner.innerHTML = '<div class="nodata-banner warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><span><strong>Supabase nicht konfiguriert:</strong> ' + esc(h.error || '–') + '</span></div>';
      if (meta) meta.textContent = '–';
      kpiHost.innerHTML = '';
      return;
    }
    if (banner) banner.innerHTML = h.error ? '<div class="nodata-banner crit"><span>' + esc(h.error) + '</span></div>' : '';
    if (meta) meta.textContent = fmtNumber(h.totalRows) + ' Beobachtungen · ' + fmtNumber(h.activeCanonicalKeys) + ' aktive Produkt-Keys';

    const cards = [
      { label: 'Beobachtungen', value: fmtNumber(h.totalRows), sub: 'gesamt', tier: 'ok' },
      { label: 'Aktive Keys', value: fmtNumber(h.activeCanonicalKeys), sub: 'noch nicht expired', tier: 'ok' },
      { label: 'Älteste', value: h.oldestObservedAt ? fmtDate(h.oldestObservedAt) : '–', sub: 'first snapshot', tier: 'neutral' },
      { label: 'Neueste', value: h.newestObservedAt ? fmtDate(h.newestObservedAt) : '–', sub: 'letzter Sync', tier: 'ok' },
    ];
    if (h.scanRunsAvailable && h.latestRun) {
      const r = h.latestRun;
      cards.push({
        label: 'Aktuelle KW',
        value: 'KW ' + r.isoWeek + ' · ' + r.isoYear,
        sub: (h.currentWeekRunCount || 0) + ' ' + ((h.currentWeekRunCount === 1) ? 'Scan' : 'Scans'),
        tier: 'ok',
      });
    }
    kpiHost.innerHTML = cards.map(kpiCard).join('');

    renderHistoryRuns();
  }

  // ---------- Offer Scan-Runs ----------
  function renderHistoryRuns() {
    const host = $('history-runs');
    if (!host) return;
    const runs = state.historyRuns;
    if (!runs || !runs.available) {
      // Table not pushed yet OR endpoint failed. Stay quiet — the dashboard
      // already shows the rest of the history block.
      host.innerHTML = '<div class="empty">Scan-Runs noch nicht verfügbar (Migration <code>20260528000003_offer_scan_runs.sql</code>).</div>';
      return;
    }
    if (!runs.runs || runs.runs.length === 0) {
      host.innerHTML = '<div class="empty">Noch keine Scan-Runs.</div>';
      return;
    }
    const statusBadge = (s) => {
      const tone = s === 'completed' ? 'ok' : (s === 'failed' ? 'crit' : 'warn');
      return '<span class="status-badge ' + tone + '">' + esc(s) + '</span>';
    };
    const typeLabel = {
      one_click_ai: 'Angebots-Scan 1.0',
      manual_sync: 'Manueller Sync',
      auto_sync: 'Auto-Sync',
      test: 'Test',
      unknown: '–',
    };
    host.innerHTML = '<div class="table-wrap"><table class="tbl"><thead><tr>' +
      '<th class="left">Zeit</th>' +
      '<th class="left">KW</th>' +
      '<th class="left">Typ</th>' +
      '<th class="left">Status</th>' +
      '<th>Angebote</th>' +
      '<th>Geschrieben</th>' +
      '<th>Expired</th>' +
      '<th>Fehler</th>' +
    '</tr></thead><tbody>' +
    runs.runs.map((r) => {
      const when = r.startedAt ? new Date(r.startedAt).toLocaleString('de-DE', { hour12: false }) : '–';
      const label = typeLabel[r.scanType] || r.scanType;
      const errCell = (r.errorCount > 0)
        ? '<td style="color:var(--crit)">' + r.errorCount + '</td>'
        : '<td>0</td>';
      return '<tr>' +
        '<td class="left">' + esc(when) + '</td>' +
        '<td class="left">KW ' + r.isoWeek + ' · ' + r.isoYear + '</td>' +
        '<td class="left">' + esc(label) + '</td>' +
        '<td class="left">' + statusBadge(r.status) + '</td>' +
        '<td>' + r.offersCount + '</td>' +
        '<td>' + r.historyWrittenCount + '</td>' +
        '<td>' + r.expiredCount + '</td>' +
        errCell +
      '</tr>';
    }).join('') +
    '</tbody></table></div>';
  }

  // ---------- Offer History · Kalenderwochen ----------
  function renderHistoryWeeks() {
    const host = $('history-weeks');
    if (!host) return;
    const w = state.historyWeeks;
    if (!w) { host.innerHTML = '<div class="empty">Lade Kalenderwochen…</div>'; return; }
    if (!w.available) {
      host.innerHTML = '<div class="empty">Offer-History benötigt SUPABASE_SERVICE_ROLE_KEY.' +
        (w.error ? ' <span style="color:var(--muted)">(' + esc(w.error) + ')</span>' : '') + '</div>';
      return;
    }
    const weeks = w.weeks || [];
    if (weeks.length === 0) {
      host.innerHTML = '<div class="empty">Noch keine Offer-History. Sobald der erste Sync läuft, erscheinen hier Kalenderwochen.</div>';
      return;
    }
    const sel = state.selectedWeek;
    const fmtRange = (a, b) => {
      const f = (s) => { const d = new Date(s + 'T00:00:00Z'); return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }); };
      return f(a) + '–' + f(b);
    };
    host.innerHTML = '<div class="kw-grid">' + weeks.map((wk) => {
      const active = sel && sel.year === wk.isoYear && sel.week === wk.isoWeek;
      return '<button type="button" class="kw-card' + (active ? ' active' : '') + '"' +
        ' data-action="history-week-select" data-year="' + wk.isoYear + '" data-week="' + wk.isoWeek + '">' +
        '<div class="kw-card-top"><span class="kw-num">KW ' + wk.isoWeek + '</span><span class="kw-year">' + wk.isoYear + '</span></div>' +
        '<div class="kw-range">' + esc(fmtRange(wk.weekStartDate, wk.weekEndDate)) + '</div>' +
        '<div class="kw-stats">' +
          '<span title="Scans / Sync-Läufe">' + ico('refresh', 11) + ' ' + (wk.scanRunCount != null ? wk.scanRunCount : '–') + '</span>' +
          '<span title="Angebote">' + ico('tag', 11) + ' ' + fmtNumber(wk.offerCount) + '</span>' +
          '<span title="Supermärkte">' + ico('inbox', 11) + ' ' + fmtNumber(wk.storeCount) + '</span>' +
        '</div>' +
      '</button>';
    }).join('') + '</div>';
  }

  function weekFilteredOffers() {
    const d = state.weekDetail;
    if (!d || !Array.isArray(d.offers)) return [];
    const q = (state.weekSearch || '').trim().toLowerCase();
    const store = state.weekStoreFilter || '';
    return d.offers.filter((o) => {
      if (store && o.store !== store) return false;
      if (state.weekOnlyRepeated && !(o.snapshotCount > 1)) return false;
      if (state.weekOnlyPriceChanged && !o.priceChanged) return false;
      if (q) {
        const hay = ((o.name || '') + ' ' + (o.brand || '') + ' ' + (o.category || '') + ' ' + (o.store || '')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  function renderWeekTable() {
    const MAX_ROWS = 200;
    const rows = weekFilteredOffers();
    if (rows.length === 0) {
      return '<div class="empty">Keine Angebote passen zu Suche/Filter.</div>';
    }
    const shown = rows.slice(0, MAX_ROWS);
    const priceCell = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n.toFixed(2).replace('.', ',') + ' €' : '–'; };
    const fmtDay = (s) => { if (!s) return '–'; const d = new Date(s); return Number.isNaN(d.getTime()) ? esc(String(s)) : d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); };
    const fmtValid = (s) => { if (!s) return '–'; const d = new Date(s + 'T00:00:00Z'); return Number.isNaN(d.getTime()) ? esc(String(s)) : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }); };
    const body = shown.map((o) => {
      const img = o.imageUrl
        ? '<img class="kw-thumb" src="' + esc(o.imageUrl) + '" alt="" loading="lazy" onerror="this.style.display=\\'none\\'">'
        : '<span class="kw-thumb kw-thumb-empty">' + ico('no_img', 12) + '</span>';
      const disc = (o.savingsPercent != null && Number(o.savingsPercent) > 0)
        ? '<span class="kw-disc">-' + Number(o.savingsPercent).toFixed(0) + '%</span>'
        : '';
      const orig = (o.originalPrice != null && Number(o.originalPrice) > 0)
        ? '<span class="kw-orig">' + Number(o.originalPrice).toFixed(2).replace('.', ',') + ' €</span>'
        : '';
      const inflated = (o.rowCount > o.snapshotCount) ? ' style="color:var(--warn)"' : '';
      return '<tr>' +
        '<td>' + img + '</td>' +
        '<td class="left bold">' + esc(o.name || '(ohne Name)') + (o.brand ? '<span class="kw-brand">' + esc(o.brand) + '</span>' : '') + '</td>' +
        '<td class="left">' + storeLogo(o.store) + '<span>' + esc(o.store) + '</span></td>' +
        '<td class="left">' + esc(o.category || '–') + '</td>' +
        '<td>' + priceCell(o.minPrice) + '</td>' +
        '<td>' + priceCell(o.avgPrice) + '</td>' +
        '<td>' + priceCell(o.maxPrice) + '</td>' +
        '<td class="left">' + (orig || disc ? (orig + ' ' + disc) : '–') + '</td>' +
        '<td>' + o.snapshotCount + '</td>' +
        '<td' + inflated + '>' + o.rowCount + '</td>' +
        '<td class="left">' + fmtDay(o.firstObserved) + '</td>' +
        '<td class="left">' + fmtDay(o.lastObserved) + '</td>' +
        '<td class="left">' + fmtValid(o.validUntil) + '</td>' +
      '</tr>';
    }).join('');
    const more = rows.length > MAX_ROWS
      ? '<div style="margin-top:8px;font-size:11px;color:var(--muted)">… und ' + fmtNumber(rows.length - MAX_ROWS) + ' weitere (gefiltert anzeigen, um die Liste zu verkürzen)</div>'
      : '';
    return '<div class="table-wrap"><table class="tbl"><thead><tr>' +
      '<th>Bild</th>' +
      '<th class="left">Produkt</th>' +
      '<th class="left">Store</th>' +
      '<th class="left">Kategorie</th>' +
      '<th>Min</th>' +
      '<th>Ø</th>' +
      '<th>Max</th>' +
      '<th class="left">Rabatt</th>' +
      '<th title="Anzahl verschiedener Snapshots / Scans">Snap.</th>' +
      '<th title="Rohe Zeilenanzahl">Zeilen</th>' +
      '<th class="left">Gesehen von</th>' +
      '<th class="left">Gesehen bis</th>' +
      '<th class="left">Gültig bis</th>' +
    '</tr></thead><tbody>' + body + '</tbody></table></div>' + more;
  }

  function renderHistoryWeekDetail() {
    const host = $('history-week-detail');
    if (!host) return;
    const sel = state.selectedWeek;
    if (!sel) {
      host.innerHTML = '<div class="empty kw-detail-hint">Wähle oben eine Kalenderwoche, um ihre Angebote zu laden.</div>';
      return;
    }
    const head = '<div class="kw-detail-head"><h4>KW ' + sel.week + ' · ' + sel.year + '</h4>';
    if (state.weekDetailLoading) {
      host.innerHTML = head + '</div><div class="empty">Lade Angebote der KW ' + sel.week + '…</div>';
      return;
    }
    if (state.weekDetailError) {
      host.innerHTML = head + '</div><div class="nodata-banner crit"><span>' + esc(state.weekDetailError) + '</span></div>';
      return;
    }
    const d = state.weekDetail;
    if (!d) { host.innerHTML = head + '</div>'; return; }
    if (!d.available) {
      host.innerHTML = head + '</div><div class="nodata-banner warn"><span>' + esc(d.error || 'Nicht verfügbar.') + '</span></div>';
      return;
    }
    if ((d.offers || []).length === 0) {
      host.innerHTML = head + '</div><div class="empty">Noch keine Offer-History für diese Woche.</div>';
      return;
    }
    const stat = (label, value) => '<span class="kw-stat"><span class="kw-stat-v">' + esc(value) + '</span><span class="kw-stat-l">' + esc(label) + '</span></span>';
    const statsBar = '<div class="kw-detail-stats">' +
      stat('Scans', d.scanRunCount != null ? d.scanRunCount : d.snapshotCount) +
      stat('Snapshots', d.snapshotCount) +
      stat('Angebote', d.offerCount) +
      stat('Stores', d.storeCount) +
      stat('Produktgruppen', d.totalGroups) +
    '</div>';
    const limitNote = d.limited
      ? '<div class="kw-limit-note">Anzeige auf ' + fmtNumber(d.returnedGroups) + ' von ' + fmtNumber(d.totalGroups) + ' Produktgruppen begrenzt.</div>'
      : '';
    // Store filter chips.
    const stores = d.stores || [];
    const storeChips = '<div class="kw-store-filter">' +
      '<button type="button" class="chip' + (state.weekStoreFilter === '' ? ' active' : '') + '" data-action="week-store-filter" data-store="">Alle</button>' +
      stores.map((s) => '<button type="button" class="chip' + (state.weekStoreFilter === s ? ' active' : '') + '" data-action="week-store-filter" data-store="' + esc(s) + '">' + esc(s) + '</button>').join('') +
    '</div>';
    const toggles = '<div class="kw-toggles">' +
      '<button type="button" class="chip' + (state.weekOnlyRepeated ? ' active' : '') + '" data-action="week-toggle-repeated">nur mehrfach beobachtet</button>' +
      '<button type="button" class="chip' + (state.weekOnlyPriceChanged ? ' active' : '') + '" data-action="week-toggle-pricechanged">nur Preis geändert</button>' +
    '</div>';
    const search = '<input id="week-search" class="kw-search" type="search" placeholder="Produkt, Marke, Kategorie…" value="' + esc(state.weekSearch || '') + '">';
    const filterBar = '<div class="kw-filter-bar">' + search + toggles + '</div>' + storeChips;
    host.innerHTML = head + '</div>' + statsBar + limitNote + filterBar +
      '<div id="history-week-table">' + renderWeekTable() + '</div>';
  }

  function renderTrends() {
    if (!state.trends) return;
    const t = state.trends;
    const banner = $('trends-banner');
    if (!t.available) {
      banner.innerHTML = '<div class="nodata-banner warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><span><strong>Supabase nicht konfiguriert:</strong> Trends können nicht aus den Views aggregiert werden.</span></div>';
    } else if ((t.missingDataNotes || []).length > 0) {
      banner.innerHTML = '<div class="nodata-banner"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><span><strong>Hinweis:</strong> ' + esc(t.missingDataNotes[0]) + ' <span class="planned-pill">geplant</span></span></div>';
    } else {
      banner.innerHTML = '';
    }
    $('trend-list-1').innerHTML = rankList(t.topAddedProducts, 'addedCount');
    $('trend-list-2').innerHTML = rankList(t.topPurchasedProducts, 'purchasedCount');
    $('trend-list-3').innerHTML = rankList(t.topPlannedRecipes, 'plannedCount30d');
    $('trend-list-4').innerHTML = rankList(t.topCookedRecipes, 'cookedCount30d');

    const tbody = document.querySelector('#store-trend-table tbody');
    if (!t.topStoreNames || t.topStoreNames.length === 0) {
      tbody.innerHTML = '<tr><td colspan="2"><div class="empty">Keine Store-Treffer in shopping_list_items.</div></td></tr>';
    } else {
      tbody.innerHTML = t.topStoreNames.map((s) =>
        '<tr><td class="left bold">' + storeLogo(s.storeName) + '<span>' + esc(s.storeName) + '</span></td>' +
        '<td>' + fmtNumber(s.count) + '</td></tr>'
      ).join('');
    }
  }

  // ---------- Users ----------
  function renderUsers() {
    if (!state.subscriptions) return;
    const s = state.subscriptions;
    if (!s.available) {
      $('users-kpi').innerHTML = '<div class="kpi"><div class="kpi-label"><span class="dot neutral"></span>Supabase</div><div class="kpi-value-row"><span class="kpi-value">–</span></div><div class="kpi-sub">nicht konfiguriert</div></div>';
      $('plan-dist').innerHTML = '<div class="empty">Supabase Service-Role nicht gesetzt.</div>';
      $('stripe-health').innerHTML = '<div class="empty">–</div>';
      return;
    }

    const cards = [
      { label: 'Nutzer gesamt', value: fmtNumber(s.totalUsers), sub: 'aus public.profiles', tier: 'ok' },
      { label: 'Neue Nutzer 7d', value: fmtNumber(s.newUsers7d), sub: 'letzte Woche', tier: 'ok' },
      { label: 'Neue Nutzer 30d', value: fmtNumber(s.newUsers30d), sub: 'letzte 30 Tage', tier: 'ok' },
      { label: 'Aktive Abos', value: fmtNumber(s.statuses?.active), sub: 'status=active', tier: 'ok' },
    ];
    $('users-kpi').innerHTML = cards.map(kpiCard).join('');

    const total = (s.tiers?.free || 0) + (s.tiers?.plus || 0) + (s.tiers?.premium || 0);
    const plans = [
      { name: 'Free', count: s.tiers?.free || 0, color: 'var(--muted-2)' },
      { name: 'Plus', count: s.tiers?.plus || 0, color: 'var(--info)' },
      { name: 'Premium', count: s.tiers?.premium || 0, color: 'var(--brand)' },
    ];
    $('plan-dist').innerHTML = '<div style="display:grid;gap:10px">' +
      plans.map((p) => {
        const pct = total > 0 ? (p.count / total) * 100 : 0;
        return '<div>' +
          '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">' +
            '<span style="font-size:12.5px;font-weight:600">' + esc(p.name) + '</span>' +
            '<span style="font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums">' + fmtNumber(p.count) + ' · ' + pct.toFixed(1).replace('.', ',') + '%</span>' +
          '</div>' +
          '<div style="height:6px;background:var(--neutral-bar);border-radius:3px;overflow:hidden">' +
            '<span style="display:block;height:100%;width:' + pct + '%;background:' + p.color + '"></span>' +
          '</div>' +
        '</div>';
      }).join('') +
      '<div style="font-size:11px;color:var(--muted);margin-top:4px;padding-top:8px;border-top:1px dashed var(--line-soft)">' +
        'Gesamt: ' + fmtNumber(total) + ' Nutzer · Conversion Paid: ' + (total > 0 ? (((plans[1].count + plans[2].count) / total) * 100).toFixed(1).replace('.', ',') : '0,0') + '%' +
      '</div>' +
    '</div>';

    const sh = [
      { label: 'Customers mit Stripe', value: fmtNumber(s.stripe?.customersWithSubscription), tier: 'ok' },
      { label: 'Events letzte 7d', value: fmtNumber(s.stripe?.recentStripeEvents7d), tier: (s.stripe?.recentStripeEvents7d || 0) > 0 ? 'ok' : 'warn' },
      { label: 'Letztes Event', value: fmtDate(s.stripe?.lastStripeEventAt), tier: 'ok' },
      { label: 'past_due', value: fmtNumber(s.statuses?.past_due), tier: (s.statuses?.past_due || 0) > 0 ? 'warn' : 'ok' },
      { label: 'canceled', value: fmtNumber(s.statuses?.canceled), tier: 'neutral' },
    ];
    $('stripe-health').innerHTML = '<div style="display:grid;gap:8px">' +
      sh.map((r) =>
        '<div style="display:grid;grid-template-columns:140px 1fr auto;gap:10px;align-items:center;font-size:12.5px">' +
          '<span style="color:var(--muted);font-size:11.5px">' + esc(r.label) + '</span>' +
          '<span style="color:var(--ink-2)">' + esc(r.value) + '</span>' +
          '<span class="status-badge ' + r.tier + '"><span class="dot ' + r.tier + '"></span>' + (r.tier === 'ok' ? 'OK' : r.tier === 'warn' ? 'Warn' : '–') + '</span>' +
        '</div>'
      ).join('') +
      (s.error ? '<div class="warning" style="color:var(--danger);font-size:11.5px">' + esc(s.error) + '</div>' : '') +
    '</div>';

    renderUserEvents();
  }

  function renderUserEvents() {
    const ue = state.userEvents;
    const banner = $('users-events-banner');
    const host = $('users-events-host');
    const meta = $('users-events-meta');
    if (!ue) {
      if (host) host.innerHTML = '<div class="empty">Lade Events…</div>';
      return;
    }
    if (meta) meta.textContent = 'aggregiert · ' + (ue.events || []).length + ' Events · keine PII';
    if (!ue.available) {
      if (banner) banner.innerHTML = '<div class="nodata-banner warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><span><strong>Supabase nicht konfiguriert:</strong> ' + esc(ue.error || '') + '</span></div>';
    } else if ((ue.missingDataNotes || []).length > 0) {
      if (banner) banner.innerHTML = '<div class="nodata-banner"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><span><strong>Hinweis:</strong> ' + esc(ue.missingDataNotes[0]) + '</span></div>';
    } else if (banner) {
      banner.innerHTML = '';
    }
    const events = ue.events || [];
    if (events.length === 0) {
      host.innerHTML = '<div class="empty">Keine Events vorhanden.</div>';
      return;
    }
    const sourceLabel = (src) => src === 'stripe_events' ? 'Stripe' : src === 'subscriptions' ? 'Subscription' : 'Profile';
    const sourceTier = (src) => src === 'stripe_events' ? 'info' : src === 'subscriptions' ? 'ok' : 'neutral';
    const rows = events.map((e) =>
      '<tr>' +
        '<td class="left" style="color:var(--muted);font-variant-numeric:tabular-nums">' + esc(fmtDate(e.occurredAt)) + '</td>' +
        '<td class="left"><code style="background:var(--bg-c);padding:1px 5px;border-radius:3px;font-size:11.5px">' + esc(e.type) + '</code></td>' +
        '<td class="left">' + (e.tier ? '<span class="pill ' + (e.tier === 'premium' ? 'brand' : '') + '">' + esc(e.tier) + '</span>' : '–') + '</td>' +
        '<td class="left">' + (e.status ? '<span class="status-badge ' + (e.status === 'active' ? 'ok' : e.status === 'past_due' ? 'warn' : e.status === 'canceled' ? 'crit' : 'neutral') + '"><span class="dot ' + (e.status === 'active' ? 'ok' : e.status === 'past_due' ? 'warn' : e.status === 'canceled' ? 'crit' : 'neutral') + '"></span>' + esc(e.status) + '</span>' : '–') + '</td>' +
        '<td class="left" style="font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--muted)">' + (e.userLabelMasked ? esc(e.userLabelMasked) : '–') + '</td>' +
        '<td class="left"><span class="status-badge ' + sourceTier(e.source) + '">' + esc(sourceLabel(e.source)) + '</span></td>' +
      '</tr>'
    ).join('');
    const countsRow = Object.entries(ue.countsByType || {})
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, 8)
      .map(([type, count]) => '<span class="pill"><strong>' + count + '</strong> ' + esc(type) + '</span>')
      .join(' ');
    host.innerHTML = (countsRow ? '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">' + countsRow + '</div>' : '') +
      '<div class="table-wrap"><table class="tbl"><thead><tr>' +
        '<th class="left">Zeit</th>' +
        '<th class="left">Event</th>' +
        '<th class="left">Tier</th>' +
        '<th class="left">Status</th>' +
        '<th class="left">User (maskiert)</th>' +
        '<th class="left">Quelle</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  // ---------- AI & Jobs ----------
  function renderAI() {
    if (!state.jobs) return;
    const j = state.jobs;

    // Show the KI-Scan abort button only while a rescan/one-click run is active.
    const scanActive = !!((j.aiRescan && j.aiRescan.running) || (j.oneClickAi && j.oneClickAi.running));
    const rescanCancel = $('ai-rescan-cancel-btn');
    if (rescanCancel) rescanCancel.style.display = scanActive ? '' : 'none';
    const rescanBtn = $('ai-rescan-btn');
    if (rescanBtn) rescanBtn.disabled = scanActive;

    const ollamaRunning = j.system?.ollama?.running;
    const ollamaPullModel = j.ollamaPull?.model;
    const cards = [
      { label: 'Ollama', value: ollamaRunning ? 'läuft' : 'gestoppt', sub: 'localhost:11434', tier: ollamaRunning ? 'ok' : 'warn' },
      { label: 'Letztes Modell', value: ollamaPullModel || '–', sub: 'pull', tier: ollamaPullModel ? 'ok' : 'neutral' },
      { label: 'Aktuelle Jobs', value: fmtNumber((j.history || []).filter((h) => h.status === 'running').length), sub: 'laufend', tier: 'info' },
      { label: 'History', value: fmtNumber((j.history || []).length), sub: 'In-Memory', tier: 'neutral' },
    ];
    $('ai-meta').textContent = 'Ollama ' + (ollamaRunning ? 'läuft' : 'gestoppt') + ' · ' + (j.history || []).length + ' Jobs heute';
    $('ai-kpi').innerHTML = cards.map(kpiCard).join('');

    $('ollama-detail').innerHTML = '<div style="display:grid;gap:8px;font-size:12.5px">' +
      [
        ['Status', ollamaRunning ? '<span class="status-badge ok"><span class="dot ok"></span>running</span>' : '<span class="status-badge warn"><span class="dot warn"></span>gestoppt</span>'],
        ['PID', j.system?.ollama?.pid ? '<span style="font-family:ui-monospace,Menlo,monospace">' + j.system.ollama.pid + '</span>' : '–'],
        ['Start', esc(fmtDate(j.system?.ollama?.startedAt))],
        ['Letzter Fehler', esc(j.system?.ollama?.lastError || '–')],
      ].map((r) => '<div style="display:flex;justify-content:space-between"><span style="color:var(--muted)">' + esc(r[0]) + '</span><span>' + r[1] + '</span></div>').join('') +
    '</div>';

    $('ollama-models').innerHTML = '<div style="display:grid;gap:6px">' +
      [
        ['Angebots-Scan 1.0', j.oneClickAi],
        ['KI Neu-Scan', j.aiRescan],
        ['Modell-Pull', j.ollamaPull],
      ].map(([title, p]) => {
        if (!p) return '';
        const tone = p.running ? 'info' : p.lastError ? 'crit' : 'ok';
        const label = p.running ? 'läuft' : p.lastError ? 'Fehler' : 'idle';
        return '<div style="display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;padding:8px 10px;border:1px solid var(--line-soft);border-radius:8px;background:var(--bg-a)">' +
          '<div><div style="font-weight:600;font-size:12.5px">' + esc(title) + '</div>' +
          '<div style="font-size:11px;color:var(--muted);margin-top:1px">' + esc(p.message || p.stage || '–') + (p.total ? ' · ' + (p.processed || 0) + '/' + p.total : '') + '</div></div>' +
          '<span class="status-badge ' + tone + '"><span class="dot ' + tone + '"></span>' + esc(label) + '</span>' +
        '</div>';
      }).join('') +
    '</div>';

    const history = j.history || [];
    if (history.length === 0) {
      $('job-history').innerHTML = '<div class="empty">Noch keine Läufe.</div>';
    } else {
      $('job-history').innerHTML = history.map((h) => {
        const st = h.status === 'running' ? 'running' : h.status === 'error' ? 'crit' : 'ok';
        const stIcon = st === 'running' ? 'refresh' : st === 'ok' ? 'check' : 'x';
        const duration = (h.startedAt && h.finishedAt) ? fmtRelative(new Date(Date.now() - (new Date(h.finishedAt).getTime() - new Date(h.startedAt).getTime()))) : '–';
        return '<div class="job-row ' + st + '">' +
          '<span class="j-ico">' + ico(stIcon, 12) + '</span>' +
          '<div><div class="j-name">' + esc(h.kind) + '</div>' +
          '<div class="j-detail">' + esc(h.message || h.lastError || '–') + '</div></div>' +
          '<span class="j-meta">' + esc(fmtTime(h.startedAt)) + '</span>' +
          '<span class="j-meta">' + esc(duration) + '</span>' +
          '<span class="status-badge ' + st + '"><span class="dot ' + st + '"></span>' + esc(statusLabel(h.status)) + '</span>' +
          '<span></span>' +
        '</div>';
      }).join('');
    }

    renderJobsHistoryDisk();
    renderOllamaModelConfig();
    renderOllamaInstalled();
    renderLidlPageImageImportPanel();
  }

  // Driven by the generic /api/admin/jobs history (kind 'lidl_page_image_import')
  // instead of a bespoke status endpoint — the job's message field already
  // carries a full human-readable summary (dry-run counts or live-import result).
  function renderLidlPageImageImportPanel() {
    const host = $('lidl-page-image-import-status');
    const badge = $('lidl-page-image-import-badge');
    const btn = $('lidl-page-image-import-btn');
    if (!host) return;
    const history = (state.jobs && state.jobs.history) || [];
    const entry = history.find((h) => h.kind === 'lidl_page_image_import');
    if (!entry) {
      if (badge) badge.textContent = 'idle';
      host.textContent = 'Noch kein Lauf gestartet.';
      return;
    }
    const running = entry.status === 'running';
    if (btn) btn.disabled = running;
    if (badge) badge.textContent = statusLabel(entry.status);
    host.style.color = entry.status === 'error' ? 'var(--danger)' : '';
    host.textContent = entry.message || entry.lastError || '–';
  }

  async function startLidlPageImageImport() {
    const dryRunBox = $('lidl-page-image-import-dryrun');
    const dryRun = !!(dryRunBox && dryRunBox.checked);
    const btn = $('lidl-page-image-import-btn');
    if (btn) btn.disabled = true;
    try {
      status(dryRun ? 'Lidl-Prospektbilder-Dry-Run wird gestartet…' : 'Lidl-Prospektbilder-Import wird gestartet…', 'info');
      await api('/api/offers/lidl-page-image-import', 'POST', { dryRun });
      await loadJobs();
      status('Lidl-Prospektbilder-Import läuft. Fortschritt unter „Imports & Quellen".', 'ok');
      for (let i = 0; i < 400; i++) {
        await sleep(3000);
        await loadJobs().catch(() => {});
        const history = (state.jobs && state.jobs.history) || [];
        const entry = history.find((h) => h.kind === 'lidl_page_image_import');
        if (entry && entry.status !== 'running') {
          status(entry.status === 'error'
            ? 'Lidl-Prospektbilder-Import fehlgeschlagen: ' + (entry.lastError || 'unbekannt')
            : (entry.message || 'Lidl-Prospektbilder-Import fertig.'), entry.status === 'error' ? 'error' : 'ok');
          await Promise.all([loadOffers(), loadOverview(), loadSources()]).catch(() => {});
          break;
        }
      }
    } catch (error) {
      status((error && error.message) || 'Lidl-Prospektbilder-Import konnte nicht gestartet werden.', 'error');
      await loadJobs().catch(() => {});
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function renderJobsHistoryDisk() {
    const host = $('job-history-disk');
    if (!host) return;
    const data = state.jobsHistory;
    const meta = $('jobs-history-meta');
    if (!data) {
      host.innerHTML = '<div class="empty" style="padding:12px">Disk-History wird geladen…</div>';
      if (meta) meta.textContent = 'lade Disk-Runs…';
      return;
    }
    const disk = data.diskRuns || [];
    if (meta) meta.textContent = (data.inMemory || []).length + ' In-Memory · ' + disk.length + ' Disk-Runs (categorizer)';
    if (disk.length === 0) {
      host.innerHTML = '<div class="empty" style="padding:12px">Keine persistierten Categorizer-Runs auf Disk.</div>';
      return;
    }
    host.innerHTML = '<div style="padding:10px 16px"><div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted);font-weight:600;margin-bottom:6px">Disk-Runs · backend/data/categorizer-runs</div>' +
      '<div class="table-wrap"><table class="tbl"><thead><tr>' +
        '<th class="left">Run-ID</th>' +
        '<th class="left">Gestartet</th>' +
        '<th class="left">Output?</th>' +
        '<th class="left">Aktion</th>' +
      '</tr></thead><tbody>' +
      disk.slice(0, 25).map((r) =>
        '<tr><td class="left" style="font-family:ui-monospace,Menlo,monospace;font-size:11.5px">' + esc(r.runId.slice(0, 20)) + '…</td>' +
        '<td class="left" style="color:var(--muted)">' + esc(fmtDate(r.startedAt)) + '</td>' +
        '<td class="left">' + (r.hasOutput ? '<span class="status-badge ok"><span class="dot ok"></span>ja</span>' : '<span class="status-badge neutral">leer</span>') + '</td>' +
        '<td class="left"><button class="btn ghost" data-action="delete-disk-run" data-dir="' + esc(r.dirName || '') + '" title="Diesen Disk-Run löschen" style="padding:3px 8px;font-size:11.5px;color:var(--danger)">Löschen</button></td></tr>'
      ).join('') +
      '</tbody></table></div>' +
      (data.notes && data.notes.length > 0 ? '<div style="margin-top:8px;font-size:11px;color:var(--muted)">' + data.notes.map((n) => '• ' + esc(n)).join('<br/>') + '</div>' : '') +
    '</div>';
  }

  // Empfohlene Defaults, falls (noch) nichts installiert ist oder als schneller
  // Einstieg — werden im Dropdown hinter den installierten Modellen gelistet.
  const RECOMMENDED_MODELS = ['qwen3:14b', 'qwen2.5:14b-instruct', 'llama3.1:8b'];

  // Befüllt das <datalist> der Modell-Combobox oben aus denselben Daten, die
  // unten in "Installierte Modelle" stehen (state.ollamaModels). Offline/0
  // Modelle: nur die Empfehlungen erscheinen, manuelles Tippen bleibt möglich.
  function renderOllamaModelOptions() {
    const list = $('ollama-model-options');
    if (!list) return;
    const data = state.ollamaModels;
    const installed = (data && data.available && Array.isArray(data.models)) ? data.models : [];
    const seen = new Set();
    const options = [];
    installed.forEach((m) => {
      if (!m || !m.name || seen.has(m.name)) return;
      seen.add(m.name);
      const bits = [m.parameterSize, m.quantization].filter(Boolean).join(' · ');
      const label = 'installiert' + (bits ? ' · ' + bits : '');
      options.push('<option value="' + esc(m.name) + '" label="' + esc(label) + '"></option>');
    });
    RECOMMENDED_MODELS.forEach((name) => {
      if (seen.has(name)) return;
      seen.add(name);
      options.push('<option value="' + esc(name) + '" label="empfohlen"></option>');
    });
    list.innerHTML = options.join('');
  }

  function renderOllamaModelConfig() {
    const input = $('ollama-model-input');
    const model = state.ollamaConfig?.model || 'qwen3:14b';
    if (input && !input.value) input.value = model;
    const meta = $('ollama-config-meta');
    if (meta) meta.textContent = ' · Scan-Modell: ' + model;
  }

  function renderOllamaInstalled() {
    renderOllamaModelOptions();
    const host = $('ollama-installed');
    const meta = $('ollama-installed-meta');
    if (!host) return;
    const data = state.ollamaModels;
    if (!data) {
      host.innerHTML = '<div class="empty" style="padding:14px">Probe läuft…</div>';
      if (meta) meta.textContent = 'Probe…';
      return;
    }
    if (!data.available) {
      if (meta) meta.textContent = 'nicht erreichbar · ' + esc(data.host);
      host.innerHTML = '<div class="panel"><div class="nodata-banner warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><span><strong>Ollama nicht erreichbar:</strong> ' + esc(data.error || '–') + ' · Host <code>' + esc(data.host) + '</code></span></div></div>';
      return;
    }
    if ((data.models || []).length === 0) {
      if (meta) meta.textContent = '0 Modelle · ' + esc(data.host);
      host.innerHTML = '<div class="empty" style="padding:14px">Keine Modelle installiert. Mit <code>ollama pull &lt;name&gt;</code> oder dem Button oben laden.</div>';
      return;
    }
    if (meta) meta.textContent = data.models.length + ' Modelle · ' + esc(data.host);
    const fmtSize = (bytes) => {
      const n = Number(bytes);
      if (!Number.isFinite(n) || n <= 0) return '–';
      return (n / 1024 / 1024 / 1024).toFixed(1).replace('.', ',') + ' GB';
    };
    host.innerHTML = '<div style="padding:10px 16px"><div class="table-wrap"><table class="tbl"><thead><tr>' +
      '<th class="left">Modell</th>' +
      '<th class="left">Family</th>' +
      '<th class="left">Größe</th>' +
      '<th class="left">Parameter</th>' +
      '<th class="left">Quantisierung</th>' +
      '<th class="left">Geändert</th>' +
    '</tr></thead><tbody>' +
    data.models.map((m) =>
      '<tr class="model-row" data-action="select-ollama-model" data-model="' + esc(m.name) + '" title="Als aktuelles Modell oben übernehmen" style="cursor:pointer">' +
      '<td class="left" style="font-family:ui-monospace,Menlo,monospace;font-size:12px">' + esc(m.name) + '</td>' +
      '<td class="left">' + esc(m.family || '–') + '</td>' +
      '<td class="left">' + esc(fmtSize(m.size)) + '</td>' +
      '<td class="left">' + esc(m.parameterSize || '–') + '</td>' +
      '<td class="left">' + esc(m.quantization || '–') + '</td>' +
      '<td class="left" style="color:var(--muted)">' + esc(fmtDate(m.modifiedAt)) + '</td></tr>'
    ).join('') +
    '</tbody></table></div></div>';
  }

  function renderImports() {
    if (!state.sources) return;
    const sources = state.sources.sources || [];
    $('imports-meta').textContent = sources.length + ' Quellen · ' +
      sources.filter((s) => (s.warnings || []).length === 0).length + ' gesund · ' +
      sources.filter((s) => (s.warnings || []).length > 0).length + ' mit Warnung';
    $('sources-table-meta').textContent = sources.length + ' Einträge';

    const typeLabel = (k) => k === 'official' ? 'HTML Scraper' : k === 'local_ocr' ? 'Prospekt OCR' : k === 'manual_rewe_import' ? 'Manueller Import' : k;
    const tbody = document.querySelector('#sources-table tbody');
    if (sources.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7"><div class="empty">Keine Quellen im Snapshot.</div></td></tr>';
    } else {
      tbody.innerHTML = sources.map((s) => {
        const tier = (s.warnings || []).length > 0 ? 'warn' : 'ok';
        const lowFlag = s.total > 0 && s.total < 5;
        return '<tr ' + (lowFlag ? 'class="low-store"' : '') + '>' +
          '<td class="left bold">' + storeLogo(s.displayName) + '<span>' + esc(s.displayName) + '</span></td>' +
          '<td class="left" style="color:var(--muted)">' + esc(typeLabel(s.kind)) + '</td>' +
          '<td>' + s.total + '</td>' +
          pctCell(s.imageCoveragePercent, { okAt: 85, warnAt: 50 }) +
          '<td class="left" style="color:var(--muted)">' + esc(fmtDate(s.latestUpdate)) + '</td>' +
          '<td class="left"><span class="status-badge ' + tier + '"><span class="dot ' + tier + '"></span>' + (tier === 'ok' ? 'gesund' : 'instabil') + '</span></td>' +
          '<td class="left" style="color:var(--muted);font-size:11.5px">' + esc((s.warnings || []).join(' · ') || '–') + '</td>' +
        '</tr>';
      }).join('');
    }

    const withWarn = sources.filter((s) => (s.warnings || []).length > 0);
    $('sources-warnings-host').innerHTML = withWarn.length === 0
      ? '<div class="empty">Keine Warnungen — alle Quellen liefern wie erwartet.</div>'
      : '<div style="display:grid;gap:6px">' + withWarn.map((s) =>
          '<div style="padding:9px 10px;border:1px solid var(--line-soft);border-left:3px solid var(--warn);border-radius:7px;background:var(--bg-a)">' +
            '<div style="font-weight:600;font-size:12.5px">' + esc(s.displayName) + '</div>' +
            '<div style="font-size:11.5px;color:var(--muted);margin-top:2px">' + esc(s.warnings.join(' · ')) + '</div>' +
          '</div>'
        ).join('') + '</div>';

    // Re-render the per-shop import-health table from the cached scan report.
    renderImportHealth();
  }

  function renderImportHealth() {
    const tbody = document.querySelector('#import-health-table tbody');
    if (!tbody) return;
    const report = state.scanReport;
    const rows = (report && report.storeImportHealth && report.storeImportHealth.stores) || [];
    const meta = $('import-health-meta');
    if (meta) meta.textContent = rows.length + ' Shops';
    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10"><div class="empty">Noch kein Scan-Report — Angebots-Scan 2.0 starten.</div></td></tr>';
      return;
    }
    // 'excluded'/'disabled' sind bewusste Zustände (übersprungen/deaktiviert),
    // kein Defekt — neutral statt rot anzeigen.
    const healthTier = (h) => h === 'ok' ? 'ok' : h === 'warning' ? 'warn' : (h === 'excluded' || h === 'disabled') ? 'neutral' : 'crit';
    const webTier = (w) => (w === 'imported' || w === 'ok') ? 'ok' : w === 'unverified' ? 'warn' : 'crit';
    tbody.innerHTML = rows.map((r) => {
      const ht = healthTier(r.importHealth);
      const wt = webTier(r.webVerification);
      const miss = (r.missingEstimate === null || r.missingEstimate === undefined) ? '–' : r.missingEstimate;
      return '<tr>' +
        '<td class="left bold">' + storeLogo(r.storeChain) + '<span>' + esc(r.storeChain) + '</span></td>' +
        '<td class="left" style="color:var(--muted);font-size:11.5px">' + esc(r.strategy) + '</td>' +
        '<td>' + (r.currentCount || 0) + '</td>' +
        '<td>' + (r.nextWeekCount || 0) + '</td>' +
        '<td>' + (r.foodCount || 0) + '</td>' +
        '<td>' + (r.nonFoodCount || 0) + '</td>' +
        '<td>' + miss + '</td>' +
        '<td>' + (r.brokenImageCount || 0) + '</td>' +
        '<td class="left"><span class="status-badge ' + wt + '"><span class="dot ' + wt + '"></span>' + esc(r.webVerification) + '</span></td>' +
        '<td class="left"><span class="status-badge ' + ht + '"><span class="dot ' + ht + '"></span>' + esc(r.importHealth) + '</span></td>' +
      '</tr>';
    }).join('');
  }

  // ---------- System & Logs ----------
  function renderSystem() {
    const sys = state.system;
    if (!sys) return;
    const svcs = [
      { name: 'Backend (Node)', tier: 'ok', port: ':8787', uptime: 'lokal', line: 'Express · req-id middleware aktiv' },
      { name: 'Mobile (Expo)', tier: sys.mobile?.running ? 'ok' : 'neutral', port: ':8081', uptime: sys.mobile?.running ? 'läuft' : 'gestoppt', line: esc(sys.mobile?.description || '–') },
      { name: 'Ollama', tier: sys.ollama?.running ? 'ok' : 'warn', port: ':11434', uptime: sys.ollama?.running ? 'läuft' : 'gestoppt', line: esc(sys.ollama?.description || '–') },
      { name: 'Frontend (Vite)', tier: sys.app?.running ? 'ok' : 'neutral', port: ':5173', uptime: sys.app?.running ? 'läuft' : 'gestoppt', line: esc(sys.app?.description || '–') },
      { name: 'Supabase', tier: state.subscriptions?.available ? 'ok' : 'warn', port: 'cloud', uptime: state.subscriptions?.available ? 'erreichbar' : 'nicht konfiguriert', line: 'Service-Role-Key im Backend-ENV' },
      { name: 'Categorizer (Py)', tier: 'neutral', port: 'spawn', uptime: 'on demand', line: 'aichef_offers · python' },
    ];
    $('svc-grid').innerHTML = svcs.map((s) =>
      '<div class="svc">' +
        '<div class="svc-head"><span class="dot ' + s.tier + '"></span>' + esc(s.name) + '</div>' +
        '<div class="svc-meta">' + esc(s.port) + ' · ' + esc(s.uptime) + '</div>' +
        '<div class="svc-line">' + s.line + '</div>' +
      '</div>'
    ).join('');

    const expoUrl = sys.mobile?.mobileExpoUrl || '';
    const qrUrl = sys.mobile?.mobileQrImageUrl || '';
    $('mobile-info').innerHTML = '<div style="display:grid;grid-template-columns:auto 1fr;gap:14px;align-items:flex-start">' +
      '<div class="qr">' + (qrUrl ? '<img alt="Expo QR" src="' + esc(qrUrl) + '" />' : '') + '</div>' +
      '<div style="display:grid;gap:6px;font-size:12.5px;min-width:0">' +
        '<div style="display:flex;justify-content:space-between;gap:10px"><span style="color:var(--muted)">Expo URL</span><code style="background:var(--bg-c);padding:1px 5px;border-radius:3px;font-size:11.5px;max-width:280px;overflow:hidden;text-overflow:ellipsis;display:inline-block">' + esc(expoUrl || '–') + '</code></div>' +
        '<div style="display:flex;justify-content:space-between"><span style="color:var(--muted)">Status</span><span>' + (sys.mobile?.running ? '<span style="color:var(--ok)">läuft</span>' : 'gestoppt') + '</span></div>' +
        '<div style="display:flex;gap:6px;margin-top:6px">' +
          '<button class="btn" data-action="mobile-start">Start</button>' +
          '<button class="btn" data-action="mobile-refresh">Refresh (r)</button>' +
          '<button class="btn danger" data-action="mobile-stop">Stop</button>' +
        '</div>' +
      '</div>' +
    '</div>';

    const clientErrs = (state.logs || []).filter((e) => e.level === 'error' && e.message === 'debug.clientError').slice(-5).reverse();
    $('client-err-meta').textContent = clientErrs.length + ' in letzten 300 Events';
    if (clientErrs.length === 0) {
      $('client-errors').innerHTML = '<div class="empty">Keine Client-Errors.</div>';
    } else {
      $('client-errors').innerHTML = '<div style="display:grid;gap:6px">' + clientErrs.map((e) => {
        const ctx = e.context || {};
        const file = ctx.source ? ctx.source + (ctx.line ? ':' + ctx.line : '') : '';
        const msg = ctx.message || '(unbekannt)';
        return '<div style="padding:9px 10px;border:1px solid var(--line-soft);border-left:3px solid var(--danger);border-radius:7px;background:var(--bg-a);display:grid;gap:3px">' +
          '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">' +
            '<span style="font-size:12.5px;color:var(--ink);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(msg) + '</span>' +
            '<span style="color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums;flex-shrink:0">' + esc(fmtTime(e.timestamp)) + '</span>' +
          '</div>' +
          (file ? '<div style="font-size:11px;color:var(--muted)"><code style="background:var(--bg-c);padding:0 4px;border-radius:3px;font-size:10.5px">' + esc(file) + '</code></div>' : '') +
        '</div>';
      }).join('') + '</div>';
    }
  }

  function renderSystemLogs() {
    const logs = state.logs || [];
    const filtered = state.logLevel === 'all' ? logs : logs.filter((l) => l.level === state.logLevel);
    if (filtered.length === 0) {
      $('logs').textContent = 'Keine Logs für diesen Filter.';
      return;
    }
    const lvlCls = { info: 'l-info', warn: 'l-warn', error: 'l-err', debug: 'l-ok' };
    $('logs').innerHTML = filtered.slice(-300).reverse().map((l) => {
      const cls = lvlCls[l.level] || 'l-info';
      const ctx = l.context ? ' ' + JSON.stringify(l.context) : '';
      return '<span class="l-time">[' + esc(fmtTime(l.timestamp)) + ']</span> ' +
        '<span class="' + cls + '">' + (l.level || 'info').toUpperCase().padEnd(5) + '</span> ' +
        '<span class="l-tag">' + esc(String(l.message).split('.')[0]).padEnd(10) + '</span> ' +
        esc(l.message) + esc(ctx);
    }).join('\\n');
  }

  // ---------- Actions ----------
  async function action(name, data) {
    try {
      if (name === 'theme-toggle') {
        const cur = document.documentElement.getAttribute('data-theme') || 'light';
        setTheme(cur === 'dark' ? 'light' : 'dark');
        return;
      }
      if (name === 'legacy-open') { window.open('/', '_blank'); return; }
      if (name === 'goto-system') { activateScreen('system'); return; }
      if (name === 'refresh-all') {
        status('Lade alle Bereiche…', 'info');
        await Promise.all([
          loadOverview(), loadOffers(), loadQuality(), loadJobs(), loadSystem(), loadLogs(), loadOllamaConfig(),
        ]);
        if (state.activeScreen === 'trends') await loadTrends();
        if (state.activeScreen === 'users') await loadSubscriptions();
        if (state.activeScreen === 'imports') await loadSources();
        status('Aktualisiert: ' + new Date().toLocaleString('de-DE'), 'ok');
        return;
      }
      if (name === 'backend-restart') {
        if (!confirm('Backend neu starten?\\n\\nDie aktuelle Instanz fährt sauber herunter und ein Relauncher startet sie neu (start-backend.ps1). Das Admin-Dashboard ist für einige Sekunden nicht erreichbar.')) {
          status('Backend-Neustart abgebrochen.', 'warn'); return;
        }
        status('Backend wird neu gestartet… (kurz nicht erreichbar)', 'info');
        try {
          const res = await api('/api/system/backend/restart', 'POST', {});
          status((res && res.message) || 'Neustart angestoßen. Seite in ~15 s neu laden.', 'ok');
        } catch (err) {
          // Erwartet: die Verbindung bricht ab, sobald der Server herunterfährt.
          status('Neustart angestoßen — Server fährt herunter. Bitte in ~15 s neu laden.', 'info');
        }
        return;
      }
      if (name === 'backend-off') {
        if (!confirm('Backend wirklich BEENDEN?\\n\\nDer Server stoppt sauber (kein harter Kill). Danach ist das Admin-Dashboard nicht mehr erreichbar, bis das Backend manuell neu gestartet wird (scripts/start-backend.ps1).')) {
          status('Backend-Beenden abgebrochen.', 'warn'); return;
        }
        status('Backend wird beendet…', 'warn');
        try {
          await api('/api/system/backend/shutdown', 'POST', {});
          status('Backend beendet. Dashboard nicht mehr erreichbar.', 'warn');
        } catch (err) {
          status('Backend wird beendet — Verbindung getrennt.', 'warn');
        }
        return;
      }
      if (name === 'one-click-ai') {
        // Angebots-Scan 1.0 scans ALL offers in one pass — confirm the large local
        // run, then send the explicit forceAll the backend still requires.
        if (!confirm('„Angebots-Scan 1.0" scannt ALLE Angebote in einem Durchlauf neu und kann mit einem lokalen Modell sehr lange dauern.\\n\\nTipp: „Angebots-Scan 2.0" macht erst einen Schnellscan und analysiert Lebensmittel separat.\\n\\nTrotzdem Angebots-Scan 1.0 starten?')) {
          status('Angebots-Scan 1.0 abgebrochen.', 'warn'); return;
        }
        status('Angebots-Scan 1.0 gestartet…', 'info');
        await api('/api/offers/one-click-ai-live/start', 'POST', { forceAll: true });
        await Promise.all([loadJobs(), loadOverview()]);
        status('Angebots-Scan 1.0 läuft. Status in „KI & Jobs".', 'ok'); return;
      }
      if (name === 'scan-v2-menu-toggle') { toggleScanV2Menu(); return; }
      if (name === 'scan-v2-start') { closeScanV2Menu(); await startScanV2(data.mode || 'phase1_phase2'); return; }
      if (name === 'scan-v2-pause') { await pauseScanV2(); return; }
      if (name === 'scan-v2-resume') { await resumeScanV2(); return; }
      if (name === 'scan-v2-cancel') { await cancelScanV2(); return; }
      if (name === 'refresh-offers') {
        status('Refresh läuft…', 'info');
        await api('/api/offers/refresh', 'POST', { tryOllama: false, enrichWithOllama: false });
        await Promise.all([loadOffers(), loadOverview(), loadQuality()]);
        status('Angebote neu geladen.', 'ok'); return;
      }
      if (name === 'filter-food') {
        status('Food Filter…', 'info');
        await api('/api/offers/filter-food', 'POST', {});
        await Promise.all([loadOffers(), loadQuality()]);
        status('Food Filter angewendet.', 'ok'); return;
      }
      if (name === 'ai-rescan') {
        status('KI Neu-Scan gestartet…', 'info');
        try {
          await api('/api/offers/rescan-food-ai/start', 'POST', { tryOllama: true });
        } catch (err) {
          const msg = (err && err.message) || '';
          if (/forceAll/i.test(msg)) {
            if (!confirm('Großer KI-Lauf über ALLE Stores.\\n\\n' + msg + '\\n\\nTrotzdem starten?')) {
              status('KI Neu-Scan abgebrochen.', 'warn'); return;
            }
            await api('/api/offers/rescan-food-ai/start', 'POST', { tryOllama: true, forceAll: true });
          } else {
            throw err;
          }
        }
        await loadJobs();
        status('KI Neu-Scan läuft.', 'ok'); return;
      }
      if (name === 'quality-ai-cancel') { await cancelQualityAi(); return; }
      if (name === 'ai-rescan-cancel') {
        await cancelQualityAi();
        await loadJobs();
        return;
      }
      if (name === 'supabase-sync') {
        status('Supabase-Sync läuft…', 'info');
        const r = await api('/api/offers/sync-supabase', 'POST', {});
        await loadOverview();
        status('Sync: ' + (r?.upserted ?? 0) + ' upserted · ' + (r?.errors?.length ?? 0) + ' Fehler.', (r?.errors?.length ?? 0) === 0 ? 'ok' : 'warn');
        return;
      }
      if (name === 'export-live-json') { await download('/api/offers/live/download?format=json', 'live.json'); status('Download JSON', 'ok'); return; }
      if (name === 'export-live-csv')  { await download('/api/offers/live/download?format=csv', 'live.csv'); status('Download CSV', 'ok'); return; }
      // Die komplette Snapshot-DATEI (offers/nextWeek/filtered + Metadaten), nicht
      // nur der Live-Bucket — gedacht zum Uebertragen auf einen zweiten Rechner.
      if (name === 'export-snapshot-file') { await download('/api/offers/snapshot/download', 'offers.json'); status('Snapshot-Datei geladen', 'ok'); return; }
      if (name === 'select-offer') {
        if (data.id) {
          if (state.selectedOffers.has(data.id)) state.selectedOffers.delete(data.id);
          else state.selectedOffers.add(data.id);
        }
        renderOffers(); return;
      }
      if (name === 'offers-selected-to-filtered') {
        const ids = [...state.selectedOffers];
        if (ids.length === 0) { status('Keine Auswahl.', 'warn'); return; }
        await api('/api/offers/live-to-filtered', 'POST', { offerIds: ids });
        state.selectedOffers.clear();
        await Promise.all([loadOffers(), loadOverview(), loadQuality()]);
        status(ids.length + ' Angebote verschoben.', 'ok'); return;
      }
      if (name === 'quality-refresh') { await Promise.all([loadQuality(), loadHistory(), loadQualityAiStatus()]); status('Datenqualität + History aktualisiert.', 'ok'); return; }
      if (name === 'enrichment-flag-toggle') {
        const category = data.category;
        if (!category) return;
        const ENRICHMENT_LABELS = { nutrition: 'Nutrition', halal: 'Halal', allergens: 'Allergene' };
        const label = ENRICHMENT_LABELS[category] || category;
        const current = state.enrichmentFlags?.flags?.[category] !== false;
        const next = !current;
        try {
          state.enrichmentFlags = await api('/api/admin/enrichment-flags', 'POST', { [category]: next });
          renderQuality();
          status(label + ': ' + (next ? 'wird in der App wieder angezeigt.' : 'wird in der App ausgeblendet.'), 'ok');
        } catch (error) {
          status((error && error.message) || 'Schalter konnte nicht geändert werden.', 'error');
        }
        return;
      }
      if (name === 'quality-ai-improve') { await runQualityAiImprove('all'); return; }
      if (name === 'quality-ai-improve-incremental') { await runQualityAiImprove('missing_or_uncertain'); return; }
      if (name === 'history-refresh') { await loadHistory(); status('Offer-History aktualisiert.', 'ok'); return; }
      if (name === 'history-week-select') {
        if (!data.year || !data.week) return;
        const year = Number(data.year);
        const week = Number(data.week);
        const sel = state.selectedWeek;
        if (sel && sel.year === year && sel.week === week) {
          // Toggle/accordion: clicking the already-open KW closes it again.
          // Pure client-side reset, no re-fetch.
          state.selectedWeek = null;
          state.weekDetail = null;
          state.weekDetailError = null;
          state.weekDetailLoading = false;
          state.weekSearch = '';
          state.weekStoreFilter = '';
          state.weekOnlyRepeated = false;
          state.weekOnlyPriceChanged = false;
          renderHistoryWeeks();
          renderHistoryWeekDetail();
          return;
        }
        await loadHistoryWeek(year, week);
        return;
      }
      if (name === 'week-store-filter') {
        state.weekStoreFilter = data.store || '';
        renderHistoryWeekDetail();
        return;
      }
      if (name === 'week-toggle-repeated') {
        state.weekOnlyRepeated = !state.weekOnlyRepeated;
        renderHistoryWeekDetail();
        return;
      }
      if (name === 'week-toggle-pricechanged') {
        state.weekOnlyPriceChanged = !state.weekOnlyPriceChanged;
        renderHistoryWeekDetail();
        return;
      }
      if (name === 'quality-download') { await download('/api/offers/quality/download', 'quality.json'); status('Download Quality JSON', 'ok'); return; }
      if (name === 'trends-refresh') { await loadTrends(); status('Trends aktualisiert.', 'ok'); return; }
      if (name === 'recipes-refresh') { await loadRecipes(); status('Rezepte aktualisiert.', 'ok'); return; }
      if (name === 'offer-quality-refresh') {
        await loadOfferQuality();
        status('Cheffity-Angebotsverbindung aktualisiert.', 'ok');
        return;
      }
      if (name === 'cheffity-match-dry') {
        status('Matcher Dry-Run läuft…', 'info');
        const r = await api('/api/cheffity/match-deals', 'POST', { dryRun: true }, 90000);
        status('Dry-Run: ' + (r.candidateMatches ?? 0) + ' Kandidaten · ' + (r.recipesWithMatches ?? 0) + ' Rezepte (nichts geschrieben).', 'ok');
        await loadOfferQuality().catch(() => {});
        return;
      }
      if (name === 'cheffity-match-write') {
        if (!confirm('Matcher ausführen und deal_recipe_matches schreiben? Verifizierte Admin-Matches bleiben unangetastet.')) {
          status('Matcher-Schreiben abgebrochen.', 'warn');
          return;
        }
        status('Matcher schreibt deal_recipe_matches…', 'info');
        const r = await api('/api/cheffity/match-deals', 'POST', { dryRun: false }, 120000);
        status('Geschrieben: ' + (r.writtenMatches ?? 0) + ' Matches · ' + (r.recipesWithMatches ?? 0) + ' Rezepte.', 'ok');
        await loadOfferQuality().catch(() => {});
        return;
      }
      if (name === 'recipe-status-toggle') {
        if (!data.id || !data.status) return;
        status('Status wird gesetzt…', 'info');
        const r = await api('/api/admin/recipes/' + encodeURIComponent(data.id) + '/status', 'PATCH', { status: data.status });
        if (state.recipes && Array.isArray(state.recipes.recipes)) {
          const rec = state.recipes.recipes.find((x) => x.id === data.id);
          if (rec && r && r.status) rec.status = r.status;
        }
        renderRecipes();
        renderNav();
        status('Status: ' + ((r && r.status) || data.status), 'ok');
        return;
      }
      if (name === 'subscriptions-refresh') { await Promise.all([loadSubscriptions(), loadUserEvents()]); status('Subscriptions + Events aktualisiert.', 'ok'); return; }
      if (name === 'users-events-refresh') { await loadUserEvents(); status('User-Events aktualisiert.', 'ok'); return; }
      if (name === 'ollama-models-refresh') { await loadOllamaModels(); status('Ollama-Modelle geprüft.', 'ok'); return; }
      if (name === 'select-ollama-model') {
        const input = $('ollama-model-input');
        if (input && data.model) { input.value = data.model; input.focus(); status('Modell übernommen: ' + data.model, 'ok'); }
        return;
      }
      if (name === 'ollama-model-save') {
        const model = ($('ollama-model-input').value || '').trim() || 'qwen3:14b';
        state.ollamaConfig = await api('/api/admin/ollama/config', 'POST', { model });
        renderOllamaModelConfig();
        status('Scan-Modell gespeichert: ' + state.ollamaConfig.model + ' (.env)', 'ok');
        return;
      }
      if (name === 'sources-refresh') { await Promise.all([loadSources(), loadScanReport()]); status('Quellen aktualisiert.', 'ok'); return; }
      if (name === 'weekly-scan-start') { await startWeeklyScan(); return; }
      if (name === 'weekly-scan-cancel') { await cancelWeeklyScan(); return; }
      if (name === 'lidl-page-image-import-start') { await startLidlPageImageImport(); return; }
      if (name === 'ollama-pull') {
        const model = ($('ollama-model-input').value || '').trim() || 'qwen3:14b';
        await api('/api/system/ollama/pull', 'POST', { model });
        await loadJobs(); status('Ollama Pull: ' + model, 'ok'); return;
      }
      if (name === 'ollama-start') { await api('/api/system/start/ollama', 'POST', {}); await loadJobs(); status('Ollama gestartet.', 'ok'); return; }
      if (name === 'ollama-stop')  { await api('/api/system/stop/ollama', 'POST', {}); await loadJobs(); status('Ollama gestoppt.', 'ok'); return; }
      if (name === 'mobile-start') {
        await api('/api/system/start/mobile', 'POST', {});
        await loadSystem();
        status('Mobile startet — warte auf Expo-URL…', 'ok');
        // Expo braucht ~20 s bis zur URL-Ausgabe. Ein einzelnes loadSystem()
        // direkt nach dem POST sieht immer noch mobileExpoUrl=null. Deshalb hier
        // kurz nachfassen, bis die URL (und damit der QR) da ist oder der
        // Prozess gescheitert ist.
        for (let attempt = 0; attempt < 20; attempt += 1) {
          await sleep(2000);
          await loadSystem().catch(() => {});
          const mob = state.system && state.system.mobile;
          if (mob && mob.mobileExpoUrl) { status('Mobile gestartet — QR bereit.', 'ok'); return; }
          if (mob && !mob.running) {
            status('Mobile-Start fehlgeschlagen: ' + (mob.lastError || 'unbekannter Fehler'), 'warn');
            return;
          }
        }
        status('Mobile laeuft, aber es kam keine Expo-URL. Log pruefen.', 'warn');
        return;
      }
      if (name === 'mobile-stop')  { await api('/api/system/stop/mobile', 'POST', {}); await loadSystem(); status('Mobile gestoppt.', 'ok'); return; }
      if (name === 'mobile-refresh') { await api('/api/system/mobile/refresh', 'POST', {}); status('Mobile Refresh (r) gesendet.', 'ok'); return; }
      if (name === 'delete-disk-run') {
        if (!data.dir) { status('Kein Run ausgewählt.', 'warn'); return; }
        if (!confirm('Diesen Categorizer-Run von der Disk löschen?\\n\\n' + data.dir + '\\n\\nNur der Ordner auf der Disk wird entfernt — laufende Jobs bleiben unberührt.')) {
          return;
        }
        status('Disk-Run wird gelöscht…', 'info');
        await api('/api/admin/jobs/history/' + encodeURIComponent(data.dir), 'DELETE');
        await loadJobsHistory();
        status('Disk-Run gelöscht.', 'ok');
        return;
      }
      if (name === 'system-refresh') { await Promise.all([loadSystem(), loadLogs(), loadJobs()]); status('System aktualisiert.', 'ok'); return; }
      if (name === 'logs-reload') { await loadLogs(); status('Logs neu geladen.', 'ok'); return; }
      if (name === 'logs-clear') { await api('/api/debug/clear', 'POST', {}); await loadLogs(); status('Logs geleert.', 'ok'); return; }
    } catch (error) {
      status((error && error.message) || 'Fehler', 'error');
    }
  }

  // ---------- Events ----------
  function attachEvents() {
    document.body.addEventListener('click', (ev) => {
      const target = ev.target;
      if (!(target instanceof Element)) return;

      // Close the Angebots-Scan 2.0 dropdown on any click outside of it.
      if (!target.closest('#scan-v2-split')) closeScanV2Menu();

      // Sidebar shell is <aside class="sidebar">, not <nav class="sidebar">,
      // so the older selector matched nothing — that's why sidebar clicks
      // (Trends, KI & Jobs, …) felt dead. Match the button directly via its
      // data-screen attribute instead.
      const nav = target.closest('.nav-item[data-screen]');
      if (nav && nav instanceof HTMLElement && nav.dataset.screen) {
        ev.preventDefault();
        activateScreen(nav.dataset.screen);
        return;
      }
      const chip = target.closest('#review-filter .chip');
      if (chip) {
        state.qualityFilter = chip.dataset.filter || 'all';
        renderQuality();
        return;
      }
      const scopeChip = target.closest('#quality-store-scope-chips .chip');
      if (scopeChip) {
        if (!scopeChip.disabled) toggleStoreScope(scopeChip.dataset.scopeStore || '__all__');
        return;
      }
      const tab = target.closest('#offers-tabs button');
      if (tab && tab.dataset.tab) {
        state.offerTab = tab.dataset.tab;
        renderOffers();
        return;
      }
      const storeBtn = target.closest('#store-filter button');
      if (storeBtn) {
        state.storeFilter = storeBtn.dataset.store || '';
        renderOffers();
        return;
      }
      const logBtn = target.closest('#log-level-filter button');
      if (logBtn && logBtn.dataset.level) {
        state.logLevel = logBtn.dataset.level;
        document.querySelectorAll('#log-level-filter button').forEach((b) => b.classList.toggle('active', b === logBtn));
        renderSystemLogs();
        return;
      }
      const rFilterBtn = target.closest('#recipes-filter button');
      if (rFilterBtn && rFilterBtn.dataset.rfilter) {
        state.recipesFilter = rFilterBtn.dataset.rfilter;
        renderRecipes();
        return;
      }
      const rCuisineBtn = target.closest('#recipes-cuisine-filter button');
      if (rCuisineBtn && rCuisineBtn.dataset.cfilter) {
        state.recipesCuisine = rCuisineBtn.dataset.cfilter;
        renderRecipes();
        return;
      }
      const actionEl = target.closest('[data-action]');
      if (actionEl) {
        ev.preventDefault();
        ev.stopPropagation();
        const name = actionEl.getAttribute('data-action');
        if (name) action(name, {
          id: actionEl.dataset.id,
          year: actionEl.dataset.year,
          week: actionEl.dataset.week,
          store: actionEl.dataset.store,
          status: actionEl.dataset.status,
          model: actionEl.dataset.model,
          mode: actionEl.dataset.mode,
          dir: actionEl.dataset.dir,
          category: actionEl.dataset.category,
        });
      }
    });
    document.body.addEventListener('input', (ev) => {
      const t = ev.target;
      if (t && t.id === 'offers-search') { state.offersSearch = String(t.value || ''); renderOffers(); }
      if (t && t.id === 'recipes-search') { state.recipesSearch = String(t.value || ''); renderRecipes(); }
      if (t && t.id === 'week-search') {
        state.weekSearch = String(t.value || '');
        // Only re-render the table so the search input keeps focus.
        const tableHost = $('history-week-table');
        if (tableHost) tableHost.innerHTML = renderWeekTable();
      }
    });
  }

  function startAutoRefresh() {
    setInterval(() => {
      Promise.all([
        loadOverview().catch(() => {}),
        loadJobs().catch(() => {}),
        loadLogs().catch(() => {}),
        // Surface a running Angebots-Scan 2.0 even after a reload; pollScanV2
        // takes over the fast updates once it detects a running scan.
        state.scanV2Polling ? Promise.resolve() : loadScanV2().catch(() => {}),
        // System & Logs mitziehen, solange der Screen offen ist: Der verwaltete
        // mobile-Prozess gibt seine Expo-URL erst ~20 s nach dem Start aus.
        // Ohne dieses Nachladen blieb das Panel auf dem Stand von Sekunde 0 —
        // der QR-Code erschien nie, obwohl das Backend ihn laengst hatte.
        state.activeScreen === 'system' ? loadSystem().catch(() => {}) : Promise.resolve(),
      ]).catch(() => {});
    }, AUTO_INTERVAL_MS);
  }

  async function init() {
    setTheme(localStorage.getItem(THEME_KEY) || 'light');
    state.activeScreen = localStorage.getItem(ACTIVE_KEY) || 'overview';
    renderNav();
    attachEvents();
    activateScreen(state.activeScreen);
    status('Lade Daten…', 'info');
    // Resilient boot: allSettled so ONE slow/failed endpoint can never freeze the
    // dashboard on „Lade Daten…". Only the fast in-memory endpoints are part of
    // the boot; the Supabase-backed overview + lazy panels fill in afterwards.
    // NOTE: loadOffers() is intentionally NOT in the boot set — /api/offers is
    // ~2 MB (789 filtered offers, full payloads) and took ~1.1 s, which was the
    // real „Lade Daten…" delay. The overview/nav only need the quality KPIs;
    // the (large) offer list is lazy-loaded when the Angebote screen is opened.
    const labels = ['Datenqualität', 'Jobs', 'System', 'Logs', 'Ollama-Config', 'Anreicherungs-Schalter'];
    const results = await Promise.allSettled([
      loadQuality(), loadJobs(), loadSystem(), loadLogs(), loadOllamaConfig(), loadEnrichmentFlags(),
    ]);
    const failed = [];
    results.forEach((r, i) => { if (r.status === 'rejected') failed.push(labels[i]); });
    if (failed.length === 0) {
      status('Bereit · /admin-v2 · Backend ' + (FRONTEND_URL || 'lokal'), 'ok');
    } else {
      status('Bereit (Teilfehler: ' + failed.join(', ') + ') · /admin-v2', 'warn');
    }
    loadOverview().catch(() => {});
    loadTrends().catch(() => {});
    loadSubscriptions().catch(() => {});
    loadSources().catch(() => {});
    loadScanV2().catch(() => {});
    startAutoRefresh();
  }
  init();
})();
  `;
}
