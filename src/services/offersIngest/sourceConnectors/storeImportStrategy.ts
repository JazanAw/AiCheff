// Per-store import strategy (Task 1) — makes the import mechanism explicit and
// machine-readable so the post-scan health report can be honest about HOW each
// store's offers were obtained, and so REWE/nahkauf are never treated as a
// normal fetch-only shop.
//
// Pure + IO-free: a single source of truth shared by the official connector
// (which can stamp it onto its store configs) and the per-store health report.
//
//   direct_html        — offers parsed from server-rendered HTML markup
//   embedded_json      — offers parsed from JSON embedded in the page
//                        (window.SSR / __NEXT_DATA__ / data-grid-data / apiData)
//   api_endpoint       — offers fetched from a JSON API the page points at
//   browser_required   — direct fetch is 403/captcha-blocked; needs the real
//                        browser bookmarklet import (REWE/nahkauf)
//   pdf_fallback       — a screenshot/PDF import is the fallback path
//   blocked_or_unverified — no known working automated path / unknown store

export type ImportStrategy =
  | 'direct_html'
  | 'embedded_json'
  | 'api_endpoint'
  | 'browser_required'
  | 'pdf_fallback'
  | 'blocked_or_unverified'
  // Effektiver Import-Weg, den der Health-Report anzeigt, NACHDEM REWE/nahkauf
  // tatsächlich manuell importiert wurden (statt des reinen "browser_required").
  | 'browser_import'
  | 'pdf_import'
  | 'manual_import';

/** Tag, das der nahkauf-Connector auf Angebote stempelt, die NUR wegen der
 *  konfigurierten NAHKAUF_MARKET_ID importiert wurden (lokale Marktangebote,
 *  national_all !== true). Der Report nutzt es als ehrlichen Beleg, dass der
 *  marktbezogene Import wirklich Angebote geliefert hat — erst dann darf die
 *  Abdeckung als 'full' statt 'national_only' gemeldet werden. */
export const NAHKAUF_LOCAL_OFFER_TAG = 'nahkauf-local';

export interface StoreImportStrategy {
  /** The primary mechanism by which this store's offers are imported. */
  strategy: ImportStrategy;
  /** Ordered fallbacks (e.g. REWE: browser_required → pdf_fallback). */
  fallbackStrategies: ImportStrategy[];
  /** True when a working automated (fetch + parse) path exists. False for
   *  stores that require a manual browser/PDF import (REWE/nahkauf) or have no
   *  known path — the health report must never claim completeness for these. */
  automated: boolean;
  /** Die rechtlich sichere öffentliche Quelle (Webseite/CDN-JSON), aus der die
   *  Angebote dieses Shops stammen — für die "welche Quelle?"-Spalte des
   *  Coverage-Audits. Kein Login/keine Anti-Bot-/robots-verbotene API. */
  publicSourceUrl?: string;
  /** Human-readable note shown in the report. */
  note?: string;
}

function strategy(
  primary: ImportStrategy,
  options: { fallbacks?: ImportStrategy[]; automated?: boolean; note?: string; publicSourceUrl?: string } = {},
): StoreImportStrategy {
  return {
    strategy: primary,
    fallbackStrategies: options.fallbacks ?? [],
    automated: options.automated ?? true,
    publicSourceUrl: options.publicSourceUrl,
    note: options.note,
  };
}

// Keys are normalized (lowercase, trimmed) store chains — see normalizeChainKey.
export const STORE_IMPORT_STRATEGIES: Record<string, StoreImportStrategy> = {
  lidl: strategy('embedded_json', {
    fallbacks: ['api_endpoint', 'direct_html'],
    publicSourceUrl: 'https://www.lidl.de/c/online-prospekte/s10005610',
  }),
  'aldi sued': strategy('direct_html', {
    publicSourceUrl: 'https://www.aldi-sued.de/produkte/wochenangebote/k/1588161426582123',
    // ALDI-SÜD-Quelle = die serverseitig gerenderten Produktkacheln/__NUXT_DATA__
    // der zentralen Wochenangebote-Sammelseite, durchpaginiert (?page=2,3,…). Das
    // ist das national veröffentlichte Online-Sortiment. NICHT strukturiert
    // abgedeckt sind: reine Prospektbild-Angebote (nur als Bild im PDF/Prospekt),
    // regionale/Filial-Markenaktionen und App-exklusive Angebote — ein dort
    // beworbenes Produkt kann deshalb legitim als source-gap fehlen, ohne dass
    // der Parser defekt ist. (Kein Login/Anti-Bot-Bypass.)
    note: 'ALDI-SÜD-Angebote stammen aus der öffentlichen Wochenangebote-Sammelseite (__NUXT_DATA__/Produktkacheln, paginiert) — nationales Online-Sortiment. Reine Prospektbild-, regionale Filial- und App-exklusive Angebote sind nicht strukturiert abgedeckt und können fehlen (source-gap, kein Parser-Defekt).',
  }),
  'aldi nord': strategy('embedded_json', {
    publicSourceUrl: 'https://www.aldi-nord.de/angebote.html',
  }),
  rewe: strategy('browser_required', {
    fallbacks: ['pdf_fallback'],
    automated: false,
    publicSourceUrl: 'https://www.rewe.de/angebote',
    note: 'REWE blockt den direkten Web-Fetch (403/Captcha/Marktauswahl) — Browser-Bookmarklet oder Screenshot/PDF-Import nötig.',
  }),
  nahkauf: strategy('api_endpoint', {
    fallbacks: ['pdf_fallback'],
    publicSourceUrl: 'https://www.nahkauf.de/angebote-im-markt/',
    note: 'nahkauf-Angebote kommen aus der öffentlichen Storyblok-CDN-API der Angebotsseite; ohne NAHKAUF_MARKET_ID nur nationale Angebote.',
  }),
  edeka: strategy('direct_html', {
    publicSourceUrl: 'https://www.edeka.de/angebote',
    note: 'EDEKA-Angebote stammen aus dem serverseitig gerenderten HTML der Angebotsseite (Template "edeka_neu", <dialog>-Karten). Ohne Marktauswahl nur die NATIONALEN Angebote — lokale/regionale Angebote (nur im Browser wählbar) sind nicht abgedeckt.',
  }),
  penny: strategy('api_endpoint', { publicSourceUrl: 'https://www.penny.de/angebote' }),
  netto: strategy('direct_html', {
    publicSourceUrl: 'https://www.netto-online.de/online-wochenangebote/c-N0794',
    note: 'Netto-Produktkacheln aus HTML; ohne Filialwahl nur die nationalen Filial-Highlights (Filialwahl-API per robots.txt ausgeschlossen) — Vollsortiment nicht verifizierbar.',
  }),
  kaufland: strategy('embedded_json', {
    publicSourceUrl: 'https://filiale.kaufland.de/angebote/aktuelle-woche.html',
  }),
  hit: strategy('api_endpoint', { publicSourceUrl: 'https://www.hit.de/angebote' }),
  norma: strategy('direct_html', { publicSourceUrl: 'https://www.norma-online.de/de/angebote/' }),
};

const UNKNOWN_STORE_STRATEGY: StoreImportStrategy = strategy('blocked_or_unverified', {
  automated: false,
  note: 'Keine bekannte automatische Import-Strategie hinterlegt — Vollständigkeit nicht verifizierbar.',
});

function normalizeChainKey(storeChain: string | undefined): string {
  return String(storeChain ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Resolve the import strategy for a store chain (case-insensitive, whitespace
 * tolerant). Unknown stores resolve to `blocked_or_unverified` so the report
 * stays honest instead of implying a working automated path.
 */
export function resolveStoreImportStrategy(storeChain: string | undefined): StoreImportStrategy {
  const key = normalizeChainKey(storeChain);
  return STORE_IMPORT_STRATEGIES[key] ?? UNKNOWN_STORE_STRATEGY;
}
