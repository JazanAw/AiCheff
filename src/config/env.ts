type EnvBag = Record<string, string | undefined>;

function readEnv(): EnvBag {
  const viteMeta = import.meta as { env?: EnvBag };
  const viteEnv = viteMeta.env ?? {};
  const globalNode = globalThis as { process?: { env?: EnvBag } };
  const nodeEnv = globalNode.process?.env ?? {};
  return { ...nodeEnv, ...viteEnv };
}

function readNumber(env: EnvBag, key: string, fallback: number): number {
  const raw = env[`VITE_${key}`] ?? env[key];
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBoolean(env: EnvBag, key: string, fallback: boolean): boolean {
  const raw = env[`VITE_${key}`] ?? env[key];
  if (!raw) {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

function readText(env: EnvBag, key: string, fallback: string): string {
  const raw = env[`VITE_${key}`] ?? env[key];
  if (!raw) {
    return fallback;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function readWeekMode(env: EnvBag): 'overlap' | 'starts' {
  const raw = readText(env, 'OFFERS_WEEK_MODE', 'overlap').toLowerCase();
  return raw === 'starts' ? 'starts' : 'overlap';
}

// Lidl-Prospektbild-OCR: 'off' (Default) = nur strukturierter Teilimport +
// Prospektseiten-BELEG, kein OCR. 'diagnostic' = die Prospekt-Bildseiten werden
// per OCR gelesen und bilanziert (Zählkette im Report), aber NICHTS geht live —
// die ehrliche Diagnose, ob/wie viele Frischeangebote sich extrahieren ließen.
// 'live' = die sicheren OCR-Kandidaten werden zusätzlich übernommen (sie
// durchlaufen anschließend den nachgelagerten zentralen Food-Gate). Bewusst
// default 'off', solange OCR nicht belastbar produktionsreif ist.
function readLidlOcrMode(env: EnvBag): 'off' | 'diagnostic' | 'live' {
  const raw = readText(env, 'LIDL_OCR_MODE', 'off').toLowerCase();
  return raw === 'live' ? 'live' : raw === 'diagnostic' ? 'diagnostic' : 'off';
}

// Preisbox-OCR-Crop-Pass (off|diagnostic|live), Default off. EIGENER, konservativer
// Schalter ZUSÄTZLICH zu LIDL_OCR_MODE: der Crop-Pass läuft nur, wenn LIDL_OCR_MODE
// != off ist (er hängt am Layout-/Wortbox-Pfad) UND dieser Schalter != off ist. Im
// diagnostic-Modus liest + bilanziert er die gezielt gecroppten Großpreis-Tiles,
// emittiert aber NICHTS live; im live-Modus gehen sichere Crop-Kandidaten zusätzlich
// live — aber nur, wenn AUCH LIDL_OCR_MODE=live (diagnostic emittiert nie live).
function readLidlOcrPriceCropMode(env: EnvBag): 'off' | 'diagnostic' | 'live' {
  const raw = readText(env, 'LIDL_OCR_PRICE_CROP_MODE', 'off').toLowerCase();
  return raw === 'live' ? 'live' : raw === 'diagnostic' ? 'diagnostic' : 'off';
}

// Lidl-Prospektbild-VISION-Import (separater Pfad NEBEN dem OCR-Pfad, Default off):
// 'off' = der Vision-Pfad läuft gar nicht. 'diagnostic' = die öffentlich geladenen
// Prospektbilder werden mit einer lokalen Vision-KI analysiert und bilanziert (Zähl-
// kette im Report), aber NICHTS geht live — die ehrliche Diagnose, ob/wie viele
// Frischeangebote sich extrahieren ließen. 'live' = die SICHEREN Vision-Kandidaten
// werden zusätzlich übernommen (sie durchlaufen anschließend dieselbe zentrale Food-/
// Non-Food-Sicherheit wie der OCR-Pfad). Bewusst getrennt vom LIDL_OCR_MODE, damit
// der OCR-Pfad nicht weiter verkompliziert wird; Default 'off'.
function readLidlVisionMode(env: EnvBag): 'off' | 'diagnostic' | 'live' {
  const raw = readText(env, 'LIDL_VISION_MODE', 'off').toLowerCase();
  return raw === 'live' ? 'live' : raw === 'diagnostic' ? 'diagnostic' : 'off';
}

// Vision-Tiling-Strategie (off|grid). Root Cause des Full-Page-Timeouts: eine ganze
// 2400px-Prospektseite ist für ein kleines lokales Vision-Modell (llava:7b) zu groß
// (analyzeError/Timeout). 'grid' zerlegt jede Seite in kleine, überlappende Ausschnitte
// (Tiles), die einzeln schnell analysiert werden. Default 'grid': sobald der Vision-Pfad
// (selbst Default off) eingeschaltet wird, greift Tiling automatisch — das behebt den
// belegten Full-Page-Timeout. 'off' erzwingt das alte Full-Page-Verhalten.
function readLidlVisionTileMode(env: EnvBag): 'off' | 'grid' {
  const raw = readText(env, 'LIDL_VISION_TILE_MODE', 'grid').toLowerCase();
  return raw === 'off' ? 'off' : 'grid';
}

// Central Ollama timeout. Accepts OLLAMA_TIMEOUT_MS directly, or
// OLLAMA_TIMEOUT_SECONDS (× 1000). Default 90 s — a local 14B model
// (qwen3:14b) on 12 GB VRAM regularly needs 30–80 s for a structured-JSON
// answer, so the previous 20 s default timed every request out, which (with
// the old silent per-offer fallback) is exactly what made scans crawl for
// hours. A single source of truth feeds both the TS Ollama client and the
// Python CLI (passed through as --ollama-timeout seconds).
function readOllamaTimeoutMs(env: EnvBag): number {
  const ms = env.VITE_OLLAMA_TIMEOUT_MS ?? env.OLLAMA_TIMEOUT_MS;
  if (ms !== undefined && ms !== '') {
    const parsed = Number(ms);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const seconds = env.VITE_OLLAMA_TIMEOUT_SECONDS ?? env.OLLAMA_TIMEOUT_SECONDS;
  if (seconds !== undefined && seconds !== '') {
    const parsed = Number(seconds);
    if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed * 1000);
  }
  return 90000;
}

const env = readEnv();

export const appConfig = {
  backendBaseUrl:
    env.VITE_BACKEND_BASE_URL ?? env.BACKEND_BASE_URL ?? 'http://localhost:8787',
  ollamaHost:
    env.VITE_OLLAMA_HOST ?? env.OLLAMA_HOST ?? 'http://localhost:11434',
  // Default updated 2026-05-30 to qwen3:14b (12 GB VRAM target, Q4_K_M).
  ollamaModel: env.VITE_OLLAMA_MODEL ?? env.OLLAMA_MODEL ?? 'qwen3:14b',
  ollamaTimeoutMs: readOllamaTimeoutMs(env),
  // Conservative local-VRAM defaults. Smaller batches keep each Ollama call
  // short enough to fit the timeout on a 12 GB GPU (qwen3:14b), and the
  // consecutive-failure ceiling makes a dead/200-erroring Ollama abort the
  // whole scan in seconds instead of grinding through thousands of offers.
  ollamaBatchSize: Math.max(1, Math.round(readNumber(env, 'OLLAMA_BATCH_SIZE', 6))),
  ollamaMaxConsecutiveFailures: Math.max(
    1,
    Math.round(readNumber(env, 'OLLAMA_MAX_CONSECUTIVE_FAILURES', 3)),
  ),
  // Guard for the "Alles neu + KI" / store-less rescan: above this many offers
  // a full-snapshot KI run must be confirmed with forceAll (or a store scope).
  ollamaAllStoresMaxOffers: Math.max(
    1,
    Math.round(readNumber(env, 'OLLAMA_ALL_STORES_MAX_OFFERS', 500)),
  ),
  ingestChunkSize: readNumber(env, 'INGEST_CHUNK_SIZE', 1800),
  ingestCacheTtlMs: readNumber(env, 'INGEST_CACHE_TTL_MS', 1800000),
  ingestRateLimitMs: readNumber(env, 'INGEST_RATE_LIMIT_MS', 350),
  useFixtureOffers: readBoolean(env, 'USE_FIXTURE_OFFERS', false),
  officialOffersTimeoutMs: readNumber(env, 'OFFICIAL_OFFERS_TIMEOUT_MS', 15000),
  // Harter Per-Store-Timeout (ms) für den offiziellen Supermarkt-Scrape (Phase 1).
  // Ein ÄUSSERER Schutz um fetchStoreOffers JE Store — unabhängig von den inneren
  // fetchOfficialText/Binary/OCR/Vision-Timeouts. Ein Store, der das überschreitet,
  // wird als fetch_failed (store_fetch_timeout) erfasst, und der Scan läuft mit dem
  // nächsten Store weiter — ein langsamer/kaputter Shop kann den Scan nie einfrieren.
  // Konservativer Default (90 s), damit ein legitim langsamer Multi-Request-Store
  // (z. B. ALDI/Penny mit vielen Kategorieseiten) noch fertig wird.
  storeFetchTimeoutMs: Math.max(
    1000,
    Math.round(readNumber(env, 'STORE_FETCH_TIMEOUT_MS', 90000)),
  ),
  officialOffersMaxCategoryRequests: readNumber(
    env,
    'OFFICIAL_OFFERS_MAX_CATEGORY_REQUESTS',
    60,
  ),
  offerWeekMode: readWeekMode(env),
  offerMaxValidityDays: readNumber(env, 'OFFERS_MAX_VALIDITY_DAYS', 21),
  // Lidl-Prospektbild-OCR-Schalter (off|diagnostic|live), Default off. Siehe
  // readLidlOcrMode für die Bedeutung der Stufen.
  lidlOcrMode: readLidlOcrMode(env),
  // Obergrenze der je Lidl-Prospekt per OCR gelesenen Bildseiten (Kosten-/Last-
  // Schranke; jede Seite ist ein Tesseract-Lauf).
  lidlOcrImageLimit: Math.max(0, Math.round(readNumber(env, 'LIDL_OCR_IMAGE_LIMIT', 8))),
  // Debug-Evidence-Modus für den Lidl-OCR (Default off): wenn an, schreibt der
  // OCR-Lauf je verarbeiteter Prospektseite kompakte JSON-Debug-Artefakte (OCR-
  // Textzeilen, Wortboxen, Layout-Input, Karten-Clusterung, Preis-/Namens-
  // Kandidaten, finale Entscheidungen) unter einen GIT-IGNORIERTEN Pfad
  // (backend/data/debug/lidl-ocr/<run-id>/). Damit liefert ein echter Live-Scan
  // reproduzierbare Fixtures, statt nur zu raten, warum „Layout: 0 Karten". Keine
  // Bilddaten werden gespeichert — nur kompakte Regionskoordinaten + Text.
  lidlOcrDebugEvidence: readBoolean(env, 'LIDL_OCR_DEBUG_EVIDENCE', false),
  // Obergrenze der je Lauf geschriebenen Debug-Seiten (begrenzt Anzahl/Größe).
  lidlOcrDebugLimit: Math.max(0, Math.round(readNumber(env, 'LIDL_OCR_DEBUG_LIMIT', 8))),
  // Preisbox-OCR-Crop-Pass-Schalter (off|diagnostic|live), Default off. Siehe
  // readLidlOcrPriceCropMode: gezieltes Re-OCR der verstümmelten Großpreis-Tiles
  // einer Karte (statt der ganzen Seite). Nur aktiv, wenn LIDL_OCR_MODE != off.
  lidlOcrPriceCropMode: readLidlOcrPriceCropMode(env),
  // Obergrenze der je Prospektseite gecroppten/OCRten Preisbox-Regionen (Kosten-
  // Schranke; jeder Crop ist ein kleiner zusätzlicher Tesseract-Lauf).
  lidlOcrPriceCropLimit: Math.max(0, Math.round(readNumber(env, 'LIDL_OCR_PRICE_CROP_LIMIT', 6))),
  // ── Lidl-Prospektbild-VISION-Import (separater Pfad, Default off) ─────────
  // Siehe readLidlVisionMode für die Bedeutung der Stufen (off/diagnostic/live).
  lidlVisionMode: readLidlVisionMode(env),
  // Obergrenze der je Lidl-Prospekt per Vision-KI analysierten Bildseiten (Kosten-/
  // Last-Schranke; jede Seite ist ein Vision-Modell-Lauf).
  lidlVisionImageLimit: Math.max(0, Math.round(readNumber(env, 'LIDL_VISION_IMAGE_LIMIT', 6))),
  // Lokales Vision-Modell (Ollama). Leer = kein dediziertes Modell gesetzt → der
  // Adapter meldet ehrlich "model unavailable", statt eine Modellantwort zu erfinden.
  lidlVisionModel: readText(env, 'LIDL_VISION_MODEL', ''),
  // Debug-Evidence für den Vision-Pfad (Default off): wenn an, schreibt der Lauf je
  // Bildseite ein kompaktes, GIT-IGNORIERTES JSON-Artefakt (Bild-URL-Tail/Hash,
  // Modell, Roh-Modell-JSON, geparste Kandidaten, finale Gate-Verdikte/Verwerfungs-
  // gründe) unter backend/data/debug/lidl-vision/<run-id>/. KEINE Bilddaten.
  lidlVisionDebugEvidence: readBoolean(env, 'LIDL_VISION_DEBUG_EVIDENCE', false),
  // Obergrenze der je Lauf geschriebenen Vision-Debug-Seiten.
  lidlVisionDebugLimit: Math.max(0, Math.round(readNumber(env, 'LIDL_VISION_DEBUG_LIMIT', 6))),
  // ── Vision-Tiling (Tile-/Crop-basierte Analyse statt Full-Page) ──────────────
  // Siehe readLidlVisionTileMode: 'grid' (Default) zerlegt jede Prospektseite in
  // kleine, überlappende Ausschnitte, die llava:7b schnell beantworten kann; 'off'
  // erzwingt das alte Full-Page-Verhalten.
  lidlVisionTileMode: readLidlVisionTileMode(env),
  // Spaltenzahl des Tile-Rasters (Default 2).
  lidlVisionTileColumns: Math.max(1, Math.round(readNumber(env, 'LIDL_VISION_TILE_COLUMNS', 2))),
  // Zeilenzahl des Tile-Rasters; 0 = adaptiv aus dem Seitenverhältnis (Default 0).
  lidlVisionTileRows: Math.max(0, Math.round(readNumber(env, 'LIDL_VISION_TILE_ROWS', 0))),
  // Überlappung benachbarter Tiles als Anteil der Tile-Kante (0..0.49, Default 0.08) —
  // genug gegen zerschnittene Karten, aber klein genug, dass keine halbe Nachbarkarte ins
  // Tile blutet (größere Überlappung erzeugte gemischte Tiles + Halluzinationen).
  lidlVisionTileOverlap: Math.min(Math.max(readNumber(env, 'LIDL_VISION_TILE_OVERLAP', 0.08), 0), 0.49),
  // Obergrenze erzeugter Tiles je Seite (Kosten-/Last-Schranke; jedes Tile ist ein
  // eigener Vision-Modell-Lauf). Klein gehalten, damit Probeläufe schnell sind.
  lidlVisionTileLimit: Math.max(1, Math.round(readNumber(env, 'LIDL_VISION_TILE_LIMIT', 8))),
  // Timeout je Tile (ms). Bewusst kurz (Default 40 s): ein kleines Tile muss schnell
  // antworten; bei Überschreitung zählt der Lauf tileAnalyzeError und macht weiter.
  lidlVisionTileTimeoutMs: Math.max(1000, Math.round(readNumber(env, 'LIDL_VISION_TILE_TIMEOUT_MS', 40000))),
  // Max. Tile-Breite/-Höhe in Quellpixeln (0 = aus). > 0 erzwingt mehr Spalten/Zeilen,
  // damit weniger Bildinhalt pro Vision-Call geht (Haupthebel gegen den Tile-Timeout neben
  // dem kurzen Prompt + num_predict). 0 lässt das adaptive 2-Spalten-Raster unverändert.
  lidlVisionTileMaxWidth: Math.max(0, Math.round(readNumber(env, 'LIDL_VISION_TILE_MAX_WIDTH', 0))),
  lidlVisionTileMaxHeight: Math.max(0, Math.round(readNumber(env, 'LIDL_VISION_TILE_MAX_HEIGHT', 0))),
  // Max. erzeugte Tokens je Vision-Antwort (Ollama num_predict). Klein (Default 384): ein
  // Tile braucht nur ein kurzes JSON — das verkürzt die Generierungszeit deutlich.
  lidlVisionNumPredict: Math.max(1, Math.round(readNumber(env, 'LIDL_VISION_NUM_PREDICT', 384))),
  // Ollama top_p (Nucleus-Sampling); < 0 = nicht setzen (Default -1 = aus, Ollama-Default).
  lidlVisionTopP: readNumber(env, 'LIDL_VISION_TOP_P', -1),
  // Subtile-Fallback (Default off): timeoutet ein Tile, wird es in kleinere Subtiles
  // zerlegt, die einzeln versucht werden — gedacht für diagnostic, strikt budgetiert.
  lidlVisionSubtileFallback: readBoolean(env, 'LIDL_VISION_SUBTILE_FALLBACK', false),
  // Globales Budget erzeugter Subtiles je Lauf (begrenzt die Fallback-Laufzeit).
  lidlVisionSubtileLimit: Math.max(0, Math.round(readNumber(env, 'LIDL_VISION_SUBTILE_LIMIT', 4))),
  // ── Wochen-Auto-Scan (Vollgas-Modus) ────────────────────────────────────
  // Automatischer Wochenlauf: alle Quellen außer den ausgeschlossenen Stores
  // scrapen, dann KI-Kategorisierung im High-Quality-Modus. REWE ist bewusst
  // ausgeschlossen (Captcha/403) und bleibt Browser-Bookmark-Import.
  weeklyScanEnabled: readBoolean(env, 'WEEKLY_SCAN_ENABLED', false),
  weeklyScanDay: readText(env, 'WEEKLY_SCAN_DAY', 'MONDAY'),
  weeklyScanTime: readText(env, 'WEEKLY_SCAN_TIME', '06:00'),
  // nahkauf ist seit dem Storyblok-Importer automatisch scrapebar (öffentliche
  // CDN-API, kein Captcha) — nur REWE bleibt Browser-/PDF-Import-only.
  weeklyScanExcludedStores: readText(env, 'WEEKLY_SCAN_EXCLUDED_STORES', 'REWE'),
  // Per Policy DEAKTIVIERTE Shops: Default leer — EDEKA, ALDI NORD, ALDI SÜD
  // und Lidl importieren wieder über strukturierte öffentliche Connectoren
  // (EDEKA national_only; Lidl über die serverseitig gelisteten
  // Aktionsprospekt-Identifier + öffentliche v4/flyer-Viewer-JSON, coverage
  // structured_only/partial_with_viewer_json — nie full, preislose Frische-
  // Hotspots bleiben pending). Ein Betreiber kann jeden Shop per ENV-CSV
  // wieder abschalten; ein deaktivierter Shop wird zusätzlich aus dem Snapshot
  // entfernt und in Cheffity/Supabase abgelaufen (siehe disabledStores.ts).
  offersDisabledStores: readText(env, 'OFFERS_DISABLED_STORES', ''),
  // Optionale nahkauf Markt-ID (z. B. 320593): zusätzlich zu den nationalen
  // Angeboten werden die lokalen Angebote dieses Markts importiert.
  nahkaufMarketId: readText(env, 'NAHKAUF_MARKET_ID', ''),
  weeklyScanAiMode: readText(env, 'WEEKLY_SCAN_AI_MODE', 'high_quality'),
  weeklyScanForceAll: readBoolean(env, 'WEEKLY_SCAN_FORCE_ALL', true),
  weeklyScanAutoSync: readBoolean(env, 'WEEKLY_SCAN_AUTO_SYNC', false),
  // Wenn true, darf der High-Quality-Lauf trotz fehlender/unzureichender GPU
  // weiterlaufen (CPU-Offload). Default false → sauberer Abbruch statt
  // stundenlangem CPU-Lauf.
  weeklyScanAllowCpu: readBoolean(env, 'WEEKLY_SCAN_ALLOW_CPU', false),
  // High-Quality-Profil: längerer Timeout (120 s) + etwas größerer Batch (8).
  weeklyScanOllamaTimeoutMs: readNumber(env, 'WEEKLY_SCAN_OLLAMA_TIMEOUT_MS', 120000),
  weeklyScanOllamaBatchSize: Math.max(
    1,
    Math.round(readNumber(env, 'WEEKLY_SCAN_OLLAMA_BATCH_SIZE', 8)),
  ),
  // KI-Rescan ("KI prüfen" / "Nur neue/unklare"): qwen3:14b braucht pro Artikel
  // mehr Zeit als der zentrale Default — höherer Per-Request-Timeout (240 s) und
  // ein optionales Per-Item-Retry-Budget (0 = aus). Beides env-konfigurierbar.
  aiRescanOllamaTimeoutMs: readNumber(env, 'AI_RESCAN_OLLAMA_TIMEOUT_MS', 240000),
  aiRescanOllamaRetries: Math.max(
    0,
    Math.round(readNumber(env, 'AI_RESCAN_OLLAMA_RETRIES', 0)),
  ),
  // Quality gate: a KI run that sent items to the model must classify at least
  // this fraction of them for real, otherwise the snapshot is NOT written (the
  // result would be mostly rule-fallback). 0.3 = 30 %. Set 0 to disable.
  aiRescanMinAiSuccessRatio: Math.min(
    1,
    Math.max(0, readNumber(env, 'AI_RESCAN_MIN_AI_SUCCESS_RATIO', 0.3)),
  ),
};
