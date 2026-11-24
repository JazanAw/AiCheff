// Aggregations für das neue Backend Admin Control Center (/admin-v2).
//
// Reine + supabase-fähige Helfer in einer Datei. Reine Helfer (Warnings,
// E-Mail-Maskierung, Trend-Normalisierung) werden unit-getestet. Der
// Supabase-Teil ist gekapselt — fehlende ENV-Vars → Endpunkt liefert
// `{ available: false, ... }`, statt zu crashen.
//
// Caching: pro Endpunkt 15 s TTL, damit Auto-Refresh die Supabase-Quote
// nicht missbraucht. Cache ist Prozess-lokal (Map), kein Disk-IO.

import nodePath from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Offer } from '../../src/types/models';
import type { QualityReport } from './offersQuality';

// --- Typen --------------------------------------------------------------

export interface AdminWarning {
  level: 'warn' | 'error';
  code: string;
  message: string;
  detail?: string;
}

export interface AdminOverviewKpis {
  liveOffers: number;
  filteredOffers: number;
  nextWeekOffers: number;
  storeCount: number;
  totalUsers: number | null;
  activeSubscriptions: number | null;
  plusUsers: number | null;
  premiumUsers: number | null;
  lastOffersRunAt: string | null;
  lastOffersRunStatus: string | null;
  lastAiRunAt: string | null;
  lastAiRunStatus: string | null;
  lastSupabaseSyncAt: string | null;
  lastSupabaseSyncStatus: string | null;
}

export interface AdminOverview {
  generatedAt: string;
  kpis: AdminOverviewKpis;
  warnings: AdminWarning[];
  supabase: { available: boolean; error: string | null };
}

export interface AdminSubscriptionCounts {
  available: boolean;
  generatedAt: string;
  error: string | null;
  totalUsers: number | null;
  newUsers7d: number | null;
  newUsers30d: number | null;
  tiers: { free: number; plus: number; premium: number } | null;
  statuses: { active: number; canceled: number; past_due: number; other: number } | null;
  stripe: {
    customersWithSubscription: number | null;
    recentStripeEvents7d: number | null;
    lastStripeEventAt: string | null;
  };
}

export interface AdminTrendsProduct {
  nameKey: string;
  displayName: string;
  addedCount: number;
  purchasedCount: number;
  uniqueUsers: number;
  latestAddedAt: string | null;
}

export interface AdminTrendsRecipe {
  recipeId: string;
  nameDe: string | null;
  plannedCount30d: number;
  cookedCount30d: number;
  swipePlanCount30d: number;
  uniquePlanners30d: number;
}

export interface AdminTrends {
  available: boolean;
  generatedAt: string;
  error: string | null;
  topAddedProducts: AdminTrendsProduct[];
  topPurchasedProducts: AdminTrendsProduct[];
  topPlannedRecipes: AdminTrendsRecipe[];
  topCookedRecipes: AdminTrendsRecipe[];
  topStoreNames: Array<{ storeName: string; count: number }>;
  missingDataNotes: string[];
}

export interface AdminSourceHealth {
  kind: 'official' | 'local_ocr' | 'manual_rewe_import';
  id: string;
  displayName: string;
  total: number;
  imageCoveragePercent: number;
  latestUpdate: string | null;
  active: boolean;
  warnings: string[];
}

export interface AdminSources {
  generatedAt: string;
  sources: AdminSourceHealth[];
}

export interface AdminJobsState {
  generatedAt: string;
  ingest: AdminProcessSummary | null;
  oneClickAi: AdminProcessSummary | null;
  aiRescan: AdminProcessSummary | null;
  ollamaPull: AdminProcessSummary | null;
  system: {
    ollama: AdminProcessSummary;
    app: AdminProcessSummary;
    mobile: AdminProcessSummary;
  };
  history: AdminJobHistoryEntry[];
  notes: string[];
}

export interface AdminProcessSummary {
  running: boolean;
  stage: string | null;
  message: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  total?: number | null;
  processed?: number | null;
  pid?: number | null;
  model?: string | null;
}

export interface AdminJobHistoryEntry {
  kind: 'ingest' | 'one_click_ai' | 'ai_rescan' | 'ollama_pull' | 'lidl_page_image_import';
  startedAt: string | null;
  finishedAt: string | null;
  status: 'running' | 'done' | 'error' | 'idle';
  message: string | null;
  lastError: string | null;
}

// --- Nutzer-Events / Ollama / Job-History (Phase 2) --------------------

/**
 * One aggregated user/subscription event.
 *
 * Keine PII: weder E-Mail, noch Name, noch User-ID. Nur `userLabelMasked`
 * (z. B. eine kurze Hash-Abkürzung) und die Aggregations-Felder
 * (Event-Typ, Tier, Status, occurredAt). Quelle wird in `source` benannt.
 */
export interface AdminUserEvent {
  id: string;
  type: string;
  label: string;
  tier: 'free' | 'plus' | 'premium' | 'unknown' | null;
  status: 'active' | 'canceled' | 'past_due' | 'trialing' | 'unknown' | null;
  occurredAt: string;
  userLabelMasked: string | null;
  source: 'stripe_events' | 'subscriptions' | 'profiles';
}

export interface AdminUserEvents {
  available: boolean;
  generatedAt: string;
  error: string | null;
  events: AdminUserEvent[];
  countsByType: Record<string, number>;
  missingDataNotes: string[];
}

export interface AdminJobsHistory {
  generatedAt: string;
  source: 'memory' | 'memory+disk';
  inMemory: AdminJobHistoryEntry[];
  diskRuns: AdminDiskRunSummary[];
  notes: string[];
}

/**
 * One entry from `backend/data/categorizer-runs/<dir>` — directory names
 * encode timestamp + run-id; we expose them as historical job markers.
 */
export interface AdminDiskRunSummary {
  runId: string;
  /** The on-disk directory name (timestamp + runId) — the delete handle. */
  dirName: string;
  startedAt: string | null;
  kind: 'categorizer';
  hasOutput: boolean;
}

export interface AdminOllamaModel {
  name: string;
  size: number | null;
  modifiedAt: string | null;
  family: string | null;
  parameterSize: string | null;
  quantization: string | null;
}

export interface AdminOllamaModels {
  available: boolean;
  generatedAt: string;
  host: string;
  models: AdminOllamaModel[];
  error: string | null;
}

// --- Reine Helfer (unit-getestet) ---------------------------------------

/**
 * Mask an email so logs/UI can show "who" without leaking PII.
 * `maxm***@example.com` — first 4 chars + domain, never the full local part.
 */
export function maskEmail(email: string | null | undefined): string {
  const value = String(email ?? '').trim();
  if (!value || !value.includes('@')) return '';
  const [local, domain] = value.split('@');
  const keep = local.slice(0, Math.min(4, Math.max(1, local.length - 1)));
  return `${keep}***@${domain}`;
}

const LOW_STORE_OFFERS_THRESHOLD = 5;
const LOW_IMAGE_COVERAGE_PERCENT = 30;
const LOW_NUTRITION_COVERAGE_PERCENT = 10;
const LOW_HALAL_COVERAGE_PERCENT = 10;
const LOW_ALLERGENS_COVERAGE_PERCENT = 10;
const CLIENT_ERROR_WARN_THRESHOLD = 3;

export interface BuildWarningsInput {
  qualityReport: QualityReport;
  ollamaRunning: boolean;
  stripeError: string | null;
  recentClientErrorCount: number;
  subscriptionsAvailable: boolean;
}

/**
 * Build the warning list shown on the overview. Pure — no IO.
 * Same input → same output; order is deterministic.
 */
export function buildWarnings(input: BuildWarningsInput): AdminWarning[] {
  const warnings: AdminWarning[] = [];
  const { qualityReport: qr, ollamaRunning, stripeError, recentClientErrorCount, subscriptionsAvailable } = input;

  for (const store of qr.stores) {
    if (store.lowOfferCount) {
      warnings.push({
        level: 'warn',
        code: 'store.low_offers',
        message: `Store "${store.storeChain}" hat nur ${store.total} Live-Angebote (Schwelle ${LOW_STORE_OFFERS_THRESHOLD}).`,
        detail: 'Connector vermutlich kaputt oder Quelle leer.',
      });
    }
  }

  if (qr.kpis.liveTotal > 0) {
    if (qr.kpis.imageCoveragePercent < LOW_IMAGE_COVERAGE_PERCENT) {
      warnings.push({
        level: 'warn',
        code: 'coverage.image_low',
        message: `Bild-Abdeckung nur ${qr.kpis.imageCoveragePercent.toFixed(1)} %.`,
      });
    }
    if (qr.kpis.nutritionCoveragePercent < LOW_NUTRITION_COVERAGE_PERCENT) {
      warnings.push({
        level: 'warn',
        code: 'coverage.nutrition_low',
        message: `Nährwert-Abdeckung nur ${qr.kpis.nutritionCoveragePercent.toFixed(1)} %.`,
        detail: 'KI-Anreicherung läuft evtl. nicht oder GTINs fehlen.',
      });
    }
    if (qr.kpis.halalCoveragePercent < LOW_HALAL_COVERAGE_PERCENT) {
      warnings.push({
        level: 'warn',
        code: 'coverage.halal_low',
        message: `Halal-Abdeckung nur ${qr.kpis.halalCoveragePercent.toFixed(1)} %.`,
      });
    }
    if (qr.kpis.allergensCoveragePercent < LOW_ALLERGENS_COVERAGE_PERCENT) {
      warnings.push({
        level: 'warn',
        code: 'coverage.allergens_low',
        message: `Allergene-Abdeckung nur ${qr.kpis.allergensCoveragePercent.toFixed(1)} %.`,
      });
    }
  }

  if (!ollamaRunning) {
    warnings.push({
      level: 'warn',
      code: 'system.ollama_offline',
      message: 'Ollama läuft nicht — KI-Anreicherung nicht möglich.',
    });
  }

  if (stripeError) {
    warnings.push({
      level: 'error',
      code: 'stripe.error',
      message: 'Stripe / Subscription-Daten nicht abrufbar.',
      detail: stripeError,
    });
  }

  if (recentClientErrorCount >= CLIENT_ERROR_WARN_THRESHOLD) {
    warnings.push({
      level: 'warn',
      code: 'client.errors_present',
      message: `${recentClientErrorCount} Client-Fehler in den letzten Logs.`,
      detail: 'Im Bereich „System & Logs" prüfen.',
    });
  }

  if (!subscriptionsAvailable) {
    warnings.push({
      level: 'warn',
      code: 'supabase.unavailable',
      message: 'Supabase-Service-Role nicht konfiguriert — Nutzer/Subs nicht sichtbar.',
      detail: 'SUPABASE_URL und SUPABASE_SERVICE_ROLE_KEY in .env setzen.',
    });
  }

  return warnings;
}

/**
 * Aggregate the top store_names from shopping_list_items rows. Counts only
 * non-blank store_name entries — the field is optional and many rows have
 * none.
 */
export function aggregateTopStoreNames(
  rows: Array<{ store_name: unknown }>,
  limit = 10,
): Array<{ storeName: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const name = typeof row.store_name === 'string' ? row.store_name.trim() : '';
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([storeName, count]) => ({ storeName, count }))
    .sort((a, b) => b.count - a.count || a.storeName.localeCompare(b.storeName, 'de'))
    .slice(0, limit);
}

/**
 * Normalize a row from `product_trend_30d` into the API shape.
 */
export function normalizeProductTrendRow(
  raw: Record<string, unknown>,
): AdminTrendsProduct | null {
  const nameKey = typeof raw.name_key === 'string' ? raw.name_key : '';
  if (!nameKey) return null;
  return {
    nameKey,
    displayName: typeof raw.sample_name === 'string' && raw.sample_name.trim()
      ? raw.sample_name.trim()
      : nameKey,
    addedCount: Number(raw.added_count ?? 0) || 0,
    purchasedCount: Number(raw.purchased_count ?? 0) || 0,
    uniqueUsers: Number(raw.unique_users ?? 0) || 0,
    latestAddedAt: typeof raw.latest_added_at === 'string' ? raw.latest_added_at : null,
  };
}

export function normalizeRecipeTrendRow(
  raw: Record<string, unknown>,
): AdminTrendsRecipe | null {
  const recipeId = typeof raw.recipe_id === 'string' ? raw.recipe_id : '';
  if (!recipeId) return null;
  return {
    recipeId,
    nameDe: typeof raw.name_de === 'string' ? raw.name_de : null,
    plannedCount30d: Number(raw.planned_count_30d ?? 0) || 0,
    cookedCount30d: Number(raw.cooked_count_30d ?? 0) || 0,
    swipePlanCount30d: Number(raw.swipe_plan_count_30d ?? 0) || 0,
    uniquePlanners30d: Number(raw.unique_planners_30d ?? 0) || 0,
  };
}

/**
 * Group the snapshot's live offers by source (per ID prefix from the
 * connector), and report per-source health: count, image-coverage, latest
 * createdAt. Mirrors `deriveDealSource` in supabaseDealsSync.ts.
 */
export function buildSourceHealth(offers: Offer[]): AdminSourceHealth[] {
  type Bucket = {
    kind: AdminSourceHealth['kind'];
    id: string;
    displayName: string;
    total: number;
    withImage: number;
    latest: string | null;
  };
  const buckets = new Map<string, Bucket>();

  for (const offer of offers) {
    const id = offer.id ?? '';
    let kind: AdminSourceHealth['kind'];
    if (id.startsWith('official_')) kind = 'official';
    else if (id.startsWith('local_')) kind = 'local_ocr';
    else if (id.startsWith('rewe_browser_')) kind = 'manual_rewe_import';
    else continue;

    const storeChain = offer.storeChain?.trim() || 'Unbekannt';
    const bucketKey = `${kind}:${storeChain}`;
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = {
        kind,
        id: bucketKey,
        displayName: storeChain,
        total: 0,
        withImage: 0,
        latest: null,
      };
      buckets.set(bucketKey, bucket);
    }
    bucket.total += 1;
    if (typeof offer.imageUrl === 'string' && offer.imageUrl.trim()) {
      bucket.withImage += 1;
    }
    const created = typeof offer.createdAt === 'string' ? offer.createdAt : null;
    if (created && (!bucket.latest || created > bucket.latest)) {
      bucket.latest = created;
    }
  }

  return [...buckets.values()]
    .map((b) => {
      const warnings: string[] = [];
      const imageCoveragePercent = b.total === 0 ? 0 : Math.round((b.withImage / b.total) * 1000) / 10;
      if (b.total > 0 && b.total < LOW_STORE_OFFERS_THRESHOLD) {
        warnings.push(`Nur ${b.total} Angebote — Scraper vermutlich kaputt.`);
      }
      if (b.total > 0 && imageCoveragePercent < LOW_IMAGE_COVERAGE_PERCENT) {
        warnings.push(`Bildabdeckung nur ${imageCoveragePercent.toFixed(1)} %.`);
      }
      return {
        kind: b.kind,
        id: b.id,
        displayName: b.displayName,
        total: b.total,
        imageCoveragePercent,
        latestUpdate: b.latest,
        active: b.total > 0,
        warnings,
      };
    })
    .sort((a, b) => a.kind.localeCompare(b.kind) || b.total - a.total);
}

/**
 * Count recent client-error log entries (the last N debug-log records).
 * Used to surface "Client Errors vorhanden" on the overview.
 */
export function countRecentClientErrors(
  logs: Array<{ level: string; message: string }>,
  windowSize = 200,
): number {
  const recent = logs.slice(-windowSize);
  let count = 0;
  for (const entry of recent) {
    if (entry.level === 'error' && entry.message === 'debug.clientError') {
      count += 1;
    }
  }
  return count;
}

/**
 * Build a short, non-PII label for a user from a UUID or any opaque string.
 * Returns the first 8 chars of the UUID-like id, padded with `…`. Used as
 * a stable per-user grouping marker in events lists — never decodes to a
 * real user. Returns null if input is empty.
 */
export function maskUserLabel(value: string | null | undefined): string | null {
  const v = String(value ?? '').trim();
  if (!v) return null;
  if (v.length <= 8) return v;
  return v.slice(0, 8) + '…';
}

/**
 * Normalize one row from `public.stripe_events` into a user event. The
 * Stripe row carries the canonical event_type (e.g. checkout.session.completed)
 * which we use directly as `type`. We do NOT join into customers/subs from
 * here — Stripe event payloads are not stored, and we want the endpoint
 * to be PII-free by construction.
 */
export function normalizeStripeEventRow(
  raw: Record<string, unknown>,
): AdminUserEvent | null {
  const id = typeof raw.id === 'string' ? raw.id : '';
  const type = typeof raw.event_type === 'string' ? raw.event_type : '';
  const at = typeof raw.processed_at === 'string' ? raw.processed_at : '';
  if (!id || !type || !at) return null;
  return {
    id: `stripe:${id}`,
    type,
    label: type,
    tier: null,
    status: null,
    occurredAt: at,
    userLabelMasked: null,
    source: 'stripe_events',
  };
}

/**
 * Normalize one `public.subscriptions` row into a "subscription updated"
 * event. We only consume tier + status + user_id (masked) + updated_at;
 * never email or stripe IDs.
 */
export function normalizeSubscriptionRow(
  raw: Record<string, unknown>,
): AdminUserEvent | null {
  const userId = typeof raw.user_id === 'string' ? raw.user_id : '';
  const updatedAt = typeof raw.updated_at === 'string' ? raw.updated_at : '';
  if (!userId || !updatedAt) return null;
  const tierRaw = String(raw.tier ?? '').toLowerCase();
  const statusRaw = String(raw.status ?? '').toLowerCase();
  const tier: AdminUserEvent['tier'] =
    tierRaw === 'free' || tierRaw === 'plus' || tierRaw === 'premium' ? tierRaw : 'unknown';
  const status: AdminUserEvent['status'] =
    statusRaw === 'active' || statusRaw === 'canceled' || statusRaw === 'past_due' || statusRaw === 'trialing'
      ? statusRaw
      : 'unknown';
  return {
    id: `sub:${userId}:${updatedAt}`,
    type: 'subscription.' + status,
    label: 'Abo · ' + tier + ' · ' + status,
    tier,
    status,
    occurredAt: updatedAt,
    userLabelMasked: maskUserLabel(userId),
    source: 'subscriptions',
  };
}

/**
 * Normalize one `public.profiles` row (just created_at) into a signup
 * event. Email/display_name explicitly dropped — never read here.
 */
export function normalizeProfileSignupRow(
  raw: Record<string, unknown>,
): AdminUserEvent | null {
  const userId = typeof raw.id === 'string' ? raw.id : '';
  const createdAt = typeof raw.created_at === 'string' ? raw.created_at : '';
  if (!userId || !createdAt) return null;
  return {
    id: `profile:${userId}`,
    type: 'user.signup',
    label: 'Neue Registrierung',
    tier: 'free',
    status: 'active',
    occurredAt: createdAt,
    userLabelMasked: maskUserLabel(userId),
    source: 'profiles',
  };
}

/**
 * Merge several event lists, dedupe by id, sort newest-first, cap to limit.
 * Pure — no IO. Tested.
 */
export function mergeUserEvents(
  lists: Array<AdminUserEvent[]>,
  limit = 50,
): AdminUserEvent[] {
  const byId = new Map<string, AdminUserEvent>();
  for (const list of lists) {
    for (const ev of list) {
      if (!byId.has(ev.id)) byId.set(ev.id, ev);
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, limit);
}

export function countEventsByType(events: AdminUserEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) {
    out[e.type] = (out[e.type] ?? 0) + 1;
  }
  return out;
}

/**
 * Parse the JSON body of `GET /api/tags` returned by Ollama. The shape is
 * `{ models: [{ name, size, modified_at, details: { family, parameter_size,
 * quantization_level } }] }`. Tolerant of missing fields; never throws.
 */
export function parseOllamaModels(value: unknown): AdminOllamaModel[] {
  if (!value || typeof value !== 'object') return [];
  const arr = (value as { models?: unknown }).models;
  if (!Array.isArray(arr)) return [];
  const out: AdminOllamaModel[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name : null;
    if (!name) continue;
    const details = (r.details && typeof r.details === 'object')
      ? (r.details as Record<string, unknown>)
      : {};
    out.push({
      name,
      size: typeof r.size === 'number' && Number.isFinite(r.size) ? r.size : null,
      modifiedAt: typeof r.modified_at === 'string' ? r.modified_at : null,
      family: typeof details.family === 'string' ? details.family : null,
      parameterSize: typeof details.parameter_size === 'string' ? details.parameter_size : null,
      quantization: typeof details.quantization_level === 'string' ? details.quantization_level : null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Parse a categorizer-run directory name into a started-at timestamp.
 * Dir format: `2026-05-27T11-51-56-537Z-<uuid>` — date is ISO with `:` and
 * `.` replaced by `-`. Returns null if it doesn't match the pattern.
 */
export function parseCategorizerRunDirName(
  dirName: string,
): AdminDiskRunSummary | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-(.+)$/.exec(dirName);
  if (!match) return null;
  const [, day, hh, mm, ss, ms, runId] = match;
  const iso = `${day}T${hh}:${mm}:${ss}.${ms}Z`;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return {
    runId,
    dirName,
    startedAt: new Date(parsed).toISOString(),
    kind: 'categorizer',
    hasOutput: false,
  };
}

/**
 * Whether a string is a valid categorizer-run directory NAME (timestamp prefix +
 * run id). Used to gate deletion: the pattern alone rejects path separators,
 * `..`, absolute paths and any other traversal, because none of those match.
 */
export function isValidCategorizerRunDirName(name: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9A-Za-z._-]+$/.test(name);
}

/**
 * Resolve a categorizer-run directory name to its absolute path UNDER `runRoot`,
 * or null when it is invalid / would escape `runRoot`. Belt-and-suspenders path
 * safety: (1) strict name pattern, (2) explicit separator/`..` rejection, and
 * (3) the resolved path must be a DIRECT child of the resolved runRoot. This is
 * the only sanctioned way the delete endpoint may turn user input into a path.
 */
export function resolveCategorizerRunPath(
  runRoot: string,
  rawDirName: string,
): string | null {
  const name = String(rawDirName ?? '').trim();
  if (!isValidCategorizerRunDirName(name)) return null;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  const root = nodePath.resolve(runRoot);
  const resolved = nodePath.resolve(root, name);
  if (resolved === root) return null;
  if (nodePath.dirname(resolved) !== root) return null;
  return resolved;
}

// --- Supabase-Backed -----------------------------------------------------

let cachedClient: SupabaseClient | null | undefined;

function getClient(): SupabaseClient | null {
  if (cachedClient !== undefined) return cachedClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    cachedClient = null;
    return null;
  }
  cachedClient = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cachedClient;
}

export function isAdminSupabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// Simple TTL cache keyed by endpoint name.
const SUPABASE_TTL_MS = 15_000;
// Hard ceiling for a Supabase round-trip used by the admin dashboard. supabase-js
// uses fetch with no default timeout, so a slow/unreachable DB right after a
// backend restart would otherwise hang the whole `/admin-v2` "Lade Daten…" boot
// (the overview awaits this). On timeout we return a graceful "unavailable"
// payload instead — the dashboard stays responsive and self-heals on the next
// poll once the real result is cached.
const SUPABASE_QUERY_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.ADMIN_SUPABASE_TIMEOUT_MS) || 6000,
);

type CacheEntry<T> = { value: T; expiresAt: number };
const cache = new Map<string, CacheEntry<unknown>>();

async function memoize<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (entry && entry.expiresAt > now) return entry.value;
  const value = await loader();
  cache.set(key, { value, expiresAt: now + ttlMs });
  return value;
}

/**
 * Race a promise against a timeout. On timeout (or a late rejection) the
 * `onTimeout` fallback value is returned. The underlying promise keeps running —
 * memoize still caches its real result for the next poll, so this only bounds
 * the latency of THIS response, never drops data permanently.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(onTimeout());
      }
    }, ms);
    promise.then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(onTimeout());
        }
      },
    );
  });
}

function unavailableSubscriptionCounts(error: string): AdminSubscriptionCounts {
  return {
    available: false,
    generatedAt: new Date().toISOString(),
    error,
    totalUsers: null,
    newUsers7d: null,
    newUsers30d: null,
    tiers: null,
    statuses: null,
    stripe: {
      customersWithSubscription: null,
      recentStripeEvents7d: null,
      lastStripeEventAt: null,
    },
  };
}

/** Invalidate the admin Supabase cache (e.g. after a sync). */
export function clearAdminAggregatorCache(): void {
  cache.clear();
}

async function safeCountSince(
  client: SupabaseClient,
  table: string,
  column: string,
  isoSince: string,
): Promise<number | null> {
  const { count, error } = await client
    .from(table)
    .select('*', { count: 'exact', head: true })
    .gte(column, isoSince);
  if (error) return null;
  return typeof count === 'number' ? count : null;
}

async function fetchSubscriptionCounts(): Promise<AdminSubscriptionCounts> {
  const stamp = new Date().toISOString();
  const client = getClient();
  if (!client) {
    return {
      available: false,
      generatedAt: stamp,
      error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY nicht gesetzt.',
      totalUsers: null,
      newUsers7d: null,
      newUsers30d: null,
      tiers: null,
      statuses: null,
      stripe: {
        customersWithSubscription: null,
        recentStripeEvents7d: null,
        lastStripeEventAt: null,
      },
    };
  }

  try {
    const now = new Date();
    const iso7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const iso30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const [
      profilesCount,
      newUsers7d,
      newUsers30d,
      subRows,
      stripeCount,
      stripeRecent,
      stripeLatest,
    ] = await Promise.all([
      client.from('profiles').select('*', { count: 'exact', head: true }),
      safeCountSince(client, 'profiles', 'created_at', iso7d),
      safeCountSince(client, 'profiles', 'created_at', iso30d),
      client
        .from('subscriptions')
        .select('tier, status, stripe_customer_id')
        .limit(20000),
      client
        .from('subscriptions')
        .select('*', { count: 'exact', head: true })
        .not('stripe_customer_id', 'is', null),
      safeCountSince(client, 'stripe_events', 'processed_at', iso7d),
      client
        .from('stripe_events')
        .select('processed_at')
        .order('processed_at', { ascending: false })
        .limit(1),
    ]);

    const tiers = { free: 0, plus: 0, premium: 0 };
    const statuses = { active: 0, canceled: 0, past_due: 0, other: 0 };
    if (subRows.data) {
      for (const row of subRows.data as Array<{ tier: string; status: string }>) {
        if (row.tier === 'plus') tiers.plus += 1;
        else if (row.tier === 'premium') tiers.premium += 1;
        else tiers.free += 1;
        if (row.status === 'active') statuses.active += 1;
        else if (row.status === 'canceled') statuses.canceled += 1;
        else if (row.status === 'past_due') statuses.past_due += 1;
        else statuses.other += 1;
      }
    }

    return {
      available: true,
      generatedAt: stamp,
      error: profilesCount.error?.message ?? subRows.error?.message ?? null,
      totalUsers: typeof profilesCount.count === 'number' ? profilesCount.count : null,
      newUsers7d,
      newUsers30d,
      tiers,
      statuses,
      stripe: {
        customersWithSubscription:
          typeof stripeCount.count === 'number' ? stripeCount.count : null,
        recentStripeEvents7d: stripeRecent,
        lastStripeEventAt:
          stripeLatest.data && stripeLatest.data[0]
            ? (stripeLatest.data[0] as { processed_at: string }).processed_at
            : null,
      },
    };
  } catch (e) {
    return {
      available: true,
      generatedAt: stamp,
      error: (e as Error).message,
      totalUsers: null,
      newUsers7d: null,
      newUsers30d: null,
      tiers: null,
      statuses: null,
      stripe: {
        customersWithSubscription: null,
        recentStripeEvents7d: null,
        lastStripeEventAt: null,
      },
    };
  }
}

async function fetchTrends(): Promise<AdminTrends> {
  const stamp = new Date().toISOString();
  const client = getClient();
  const missingNotes: string[] = [];
  if (!client) {
    return {
      available: false,
      generatedAt: stamp,
      error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY nicht gesetzt.',
      topAddedProducts: [],
      topPurchasedProducts: [],
      topPlannedRecipes: [],
      topCookedRecipes: [],
      topStoreNames: [],
      missingDataNotes: [
        'Supabase nicht konfiguriert — Trends können nicht aggregiert werden.',
      ],
    };
  }

  try {
    const [productRows, recipeRows, storeRows] = await Promise.all([
      client
        .from('product_trend_30d')
        .select('name_key, sample_name, added_count, purchased_count, unique_users, latest_added_at')
        .order('added_count', { ascending: false })
        .limit(50),
      client
        .from('recipe_trend_30d')
        .select(
          'recipe_id, name_de, planned_count_30d, cooked_count_30d, swipe_plan_count_30d, unique_planners_30d',
        )
        .order('planned_count_30d', { ascending: false })
        .limit(50),
      client
        .from('shopping_list_items')
        .select('store_name')
        .not('store_name', 'is', null)
        .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
        .limit(5000),
    ]);

    const products = (productRows.data ?? [])
      .map((row) => normalizeProductTrendRow(row as Record<string, unknown>))
      .filter((row): row is AdminTrendsProduct => row !== null);
    const recipes = (recipeRows.data ?? [])
      .map((row) => normalizeRecipeTrendRow(row as Record<string, unknown>))
      .filter((row): row is AdminTrendsRecipe => row !== null);

    if (productRows.error) missingNotes.push(`product_trend_30d: ${productRows.error.message}`);
    if (recipeRows.error) missingNotes.push(`recipe_trend_30d: ${recipeRows.error.message}`);
    if (products.length === 0 && !productRows.error) {
      missingNotes.push(
        'product_trend_30d ist leer — Schwelle der View ist `count >= 2`. Es fehlen entweder Einkaufslisten-Daten oder die View muss neu indiziert werden.',
      );
    }
    if (recipes.length === 0 && !recipeRows.error) {
      missingNotes.push('recipe_trend_30d ist leer — keine Wochenpläne/Cooked-Logs in den letzten 30 Tagen.');
    }

    return {
      available: true,
      generatedAt: stamp,
      error: null,
      topAddedProducts: [...products].sort((a, b) => b.addedCount - a.addedCount).slice(0, 10),
      topPurchasedProducts: [...products]
        .filter((p) => p.purchasedCount > 0)
        .sort((a, b) => b.purchasedCount - a.purchasedCount)
        .slice(0, 10),
      topPlannedRecipes: [...recipes]
        .sort((a, b) => b.plannedCount30d - a.plannedCount30d)
        .slice(0, 10),
      topCookedRecipes: [...recipes]
        .filter((r) => r.cookedCount30d > 0)
        .sort((a, b) => b.cookedCount30d - a.cookedCount30d)
        .slice(0, 10),
      topStoreNames: aggregateTopStoreNames(
        (storeRows.data ?? []) as Array<{ store_name: unknown }>,
      ),
      missingDataNotes: missingNotes,
    };
  } catch (e) {
    return {
      available: true,
      generatedAt: stamp,
      error: (e as Error).message,
      topAddedProducts: [],
      topPurchasedProducts: [],
      topPlannedRecipes: [],
      topCookedRecipes: [],
      topStoreNames: [],
      missingDataNotes: missingNotes,
    };
  }
}

async function fetchUserEvents(limit = 50): Promise<AdminUserEvents> {
  const stamp = new Date().toISOString();
  const client = getClient();
  if (!client) {
    return {
      available: false,
      generatedAt: stamp,
      error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY nicht gesetzt.',
      events: [],
      countsByType: {},
      missingDataNotes: ['Supabase nicht konfiguriert — Events können nicht aggregiert werden.'],
    };
  }

  const notes: string[] = [];
  try {
    // Fetch from 3 PII-safe sources concurrently. None of these selects
    // touch `email`, `display_name`, `stripe_customer_id`, or any other
    // direct identifier — only IDs (which are masked) + timestamps + types.
    const [stripeRes, subRes, profileRes] = await Promise.all([
      client
        .from('stripe_events')
        .select('id, event_type, processed_at')
        .order('processed_at', { ascending: false })
        .limit(limit),
      client
        .from('subscriptions')
        .select('user_id, tier, status, updated_at')
        .order('updated_at', { ascending: false })
        .limit(limit),
      client
        .from('profiles')
        .select('id, created_at')
        .order('created_at', { ascending: false })
        .limit(limit),
    ]);

    if (stripeRes.error) notes.push(`stripe_events: ${stripeRes.error.message}`);
    if (subRes.error) notes.push(`subscriptions: ${subRes.error.message}`);
    if (profileRes.error) notes.push(`profiles: ${profileRes.error.message}`);

    const stripeEvents = (stripeRes.data ?? [])
      .map((r) => normalizeStripeEventRow(r as Record<string, unknown>))
      .filter((r): r is AdminUserEvent => r !== null);
    const subEvents = (subRes.data ?? [])
      .map((r) => normalizeSubscriptionRow(r as Record<string, unknown>))
      .filter((r): r is AdminUserEvent => r !== null);
    const profileEvents = (profileRes.data ?? [])
      .map((r) => normalizeProfileSignupRow(r as Record<string, unknown>))
      .filter((r): r is AdminUserEvent => r !== null);

    const events = mergeUserEvents([stripeEvents, subEvents, profileEvents], limit);
    if (events.length === 0 && notes.length === 0) {
      notes.push('Noch keine Events — Supabase verbunden, aber alle drei Quellen sind leer.');
    }

    return {
      available: true,
      generatedAt: stamp,
      error: null,
      events,
      countsByType: countEventsByType(events),
      missingDataNotes: notes,
    };
  } catch (e) {
    return {
      available: true,
      generatedAt: stamp,
      error: (e as Error).message,
      events: [],
      countsByType: {},
      missingDataNotes: notes,
    };
  }
}

/**
 * Probe the local Ollama API for installed models. Short timeout so the
 * admin dashboard never blocks if Ollama is down. Returns
 * `{ available: false, error }` on any failure — UI shows empty state.
 */
export async function probeOllamaModels(
  host: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 2500,
): Promise<AdminOllamaModels> {
  const stamp = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${host}/api/tags`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!res.ok) {
      return { available: false, generatedAt: stamp, host, models: [], error: `HTTP ${res.status}` };
    }
    const body = await res.json().catch(() => null);
    const models = parseOllamaModels(body);
    return { available: true, generatedAt: stamp, host, models, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Ollama nicht erreichbar';
    return { available: false, generatedAt: stamp, host, models: [], error: msg };
  } finally {
    clearTimeout(timer);
  }
}

// --- Public Entry Points -------------------------------------------------

export interface OverviewInput {
  qualityReport: QualityReport;
  ingestState: { running: boolean; finishedAt: string | null; lastError: string | null; message: string };
  oneClickAi: { running: boolean; finishedAt: string | null; lastError: string | null; stage: string };
  ollamaRunning: boolean;
  recentLogs: Array<{ level: string; message: string }>;
  lastSupabaseSync: { at: string | null; status: string | null } | null;
}

export async function getOverview(input: OverviewInput): Promise<AdminOverview> {
  // Time-bounded so a cold/slow Supabase never hangs the /admin-v2 boot. The
  // offer KPIs below come from the in-memory quality report and are unaffected.
  const subs = await withTimeout(
    memoize('subscriptions', SUPABASE_TTL_MS, fetchSubscriptionCounts),
    SUPABASE_QUERY_TIMEOUT_MS,
    () =>
      unavailableSubscriptionCounts(
        `Supabase-Timeout (>${SUPABASE_QUERY_TIMEOUT_MS} ms) — Uebersicht ohne Abo-Daten geladen.`,
      ),
  );
  const recentClientErrorCount = countRecentClientErrors(input.recentLogs);

  const warnings = buildWarnings({
    qualityReport: input.qualityReport,
    ollamaRunning: input.ollamaRunning,
    stripeError: subs.error,
    recentClientErrorCount,
    subscriptionsAvailable: subs.available,
  });

  return {
    generatedAt: new Date().toISOString(),
    kpis: {
      liveOffers: input.qualityReport.kpis.liveTotal,
      filteredOffers: input.qualityReport.kpis.filteredTotal,
      nextWeekOffers: input.qualityReport.kpis.nextWeekTotal,
      storeCount: input.qualityReport.kpis.storeCount,
      totalUsers: subs.totalUsers,
      activeSubscriptions: subs.statuses?.active ?? null,
      plusUsers: subs.tiers?.plus ?? null,
      premiumUsers: subs.tiers?.premium ?? null,
      lastOffersRunAt: input.ingestState.finishedAt,
      lastOffersRunStatus: input.ingestState.running
        ? 'running'
        : input.ingestState.lastError
          ? 'error'
          : input.ingestState.finishedAt
            ? 'ok'
            : 'idle',
      lastAiRunAt: input.oneClickAi.finishedAt,
      lastAiRunStatus: input.oneClickAi.running
        ? 'running'
        : input.oneClickAi.lastError
          ? 'error'
          : input.oneClickAi.finishedAt
            ? 'ok'
            : 'idle',
      lastSupabaseSyncAt: input.lastSupabaseSync?.at ?? null,
      lastSupabaseSyncStatus: input.lastSupabaseSync?.status ?? null,
    },
    warnings,
    supabase: { available: subs.available, error: subs.error },
  };
}

export async function getSubscriptions(): Promise<AdminSubscriptionCounts> {
  return withTimeout(
    memoize('subscriptions', SUPABASE_TTL_MS, fetchSubscriptionCounts),
    SUPABASE_QUERY_TIMEOUT_MS,
    () =>
      unavailableSubscriptionCounts(
        `Supabase-Timeout (>${SUPABASE_QUERY_TIMEOUT_MS} ms) — Abo-Daten aktuell nicht verfuegbar.`,
      ),
  );
}

export async function getTrends(): Promise<AdminTrends> {
  return memoize('trends', SUPABASE_TTL_MS, fetchTrends);
}

/**
 * Aggregierte User-/Subscription-Events für /admin-v2.
 * Cached 15 s. Keine PII über `userLabelMasked` hinaus.
 */
export async function getUserEvents(limit = 50): Promise<AdminUserEvents> {
  return memoize(`user-events:${limit}`, SUPABASE_TTL_MS, () => fetchUserEvents(limit));
}

/**
 * Read the historical categorizer-run directories from disk and return
 * them as job-history markers. Each directory name encodes its start
 * timestamp + run id (see `parseCategorizerRunDirName`). Errors are
 * swallowed — returns an empty array if the directory does not exist.
 */
export async function listCategorizerRuns(
  rootDir: string,
  readdir: (path: string, opts?: { withFileTypes?: true }) => Promise<unknown>,
  stat: (path: string) => Promise<{ isDirectory(): boolean } | null>,
): Promise<AdminDiskRunSummary[]> {
  let entries: string[] = [];
  try {
    const raw = await readdir(rootDir);
    entries = Array.isArray(raw) ? (raw as string[]).map((e) => String(e)) : [];
  } catch {
    return [];
  }
  const out: AdminDiskRunSummary[] = [];
  for (const entry of entries) {
    const parsed = parseCategorizerRunDirName(entry);
    if (!parsed) continue;
    let hasOutput = false;
    try {
      const s = await stat(`${rootDir}/${entry}/out`);
      hasOutput = !!s && s.isDirectory();
    } catch {
      hasOutput = false;
    }
    out.push({ ...parsed, hasOutput });
  }
  return out.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
}
