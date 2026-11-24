import { spawn } from 'node:child_process';
import { existsSync, promises as fsPromises, writeFileSync as fsWriteFileSync } from 'node:fs';
import * as path from 'node:path';
import 'dotenv/config';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { renderDashboardHtml } from './dashboardHtml';
import { renderAdminDashboardHtml } from './adminDashboard/index';
import {
  buildSourceHealth,
  clearAdminAggregatorCache,
  getOverview,
  getSubscriptions,
  getTrends,
  getUserEvents,
  isAdminSupabaseConfigured,
  listCategorizerRuns,
  probeOllamaModels,
  resolveCategorizerRunPath,
  type AdminJobsHistory,
  type AdminJobsState,
  type AdminProcessSummary,
  type AdminSources,
} from './adminAggregator';
import {
  getAdminRecipes,
  isRecipeAdminConfigured,
  updateRecipeReview,
  updateRecipeStatus,
} from './recipeAdmin';
import { deriveDealEnrichment } from './dealFields';
import {
  ENRICHMENT_CATEGORIES,
  enrichmentFlagEnvKey,
  resolveEnrichmentFlags,
  type EnrichmentCategory,
} from './enrichmentFlags';
import { computeQualityReport } from './offersQuality';
import {
  buildScanReport,
  renderScanReportMarkdown,
  type ScanReport,
} from './scanReport';
import { createScanReportCache } from './scanReportCache';
import {
  guardStdioAgainstEpipe,
  registerProcessLifecycleLogging,
} from './processLifecycle';
import { createLifecycleFileLogger } from './lifecycleFileLog';
import { startHeartbeat } from './heartbeat';
import { buildStoreExpectations } from './storeCompleteness';
import {
  isSupabaseSyncConfigured,
  syncDealsToSupabase,
} from './services/supabaseDealsSync';
import {
  isDealMatcherConfigured,
  runDealRecipeMatch,
} from './services/dealRecipeMatcher';
import {
  emptyOfferQualityReport,
  isOfferQualityConfigured,
  runCheffityOfferQuality,
} from './services/cheffityOfferQuality';
import {
  getHistoryStats,
  getHistoryWeekDetail,
  getHistoryWeeks,
  getOfferScanRuns,
  writeOfferHistory,
} from './offerHistory';
import {
  generateRecipes,
  isRecipeGenerationConfigured,
} from './services/recipeGeneration';
import {
  cleanupStaleCategorizerRuns,
  PipelineCancelledError,
  runOffersCategorizerPipeline,
  type OffersCategorizerProgress,
  type OffersCategorizerResult,
} from './offersCategorizerBridge';
import {
  runOllamaPreflight,
  parseOllamaOffloadLayers,
  getOllamaPsStatus,
  classifyOllamaRuntime,
  type OllamaRuntimeSource,
} from './ollamaPreflight';
import {
  evaluateAllStoresGuard,
  isZeroAiClassificationFailure,
} from './aiScanGuards';
import {
  isStoreExcluded,
  isoWeekLabel,
  parseExcludedStores,
  partitionExcludedFromBuckets,
  resolveWeeklyScanProfile,
  shouldRunWeeklyScanNow,
  type WeeklyScanPhase,
} from './weeklyAutoScan';
import {
  disabledStoreDisplayNames,
  isStoreDisabled,
  parseDisabledStores,
  purgeDisabledFromBuckets,
} from './disabledStores';
import { runGpuPreflight, type LoadedModelGpuStatus } from './gpuPreflight';
import {
  mergeScopedRescan,
  normalizeStoreChains,
  partitionOffersForScope,
  type SnapshotBuckets,
} from './offerAiRescanScope';
import {
  PRODUCT_INTELLIGENCE_VERSION,
  buildProductAnalysisIndex,
  countUncertain,
  dedupeByProductKey,
  planIncrementalScan,
  productKeyForOffer,
  reuseProductAnalysis,
  selectAiCandidates,
  splitFoodAndNonFood,
  stampAnalysisMeta,
} from './offerProductIntelligence';
import {
  applyFragmentQuarantineGate,
  checkOffersImages,
  createInitialScanV2Status,
  modeIncludesPhase1,
  modeIncludesPhase2,
  parseScanV2Mode,
  partitionFoodForAnalysis,
  quarantineFragmentOffers,
  selectUncertainFilteredForPhase2,
  stripPhase2RecheckTag,
  isPhase2Recheck,
  type ScanV2Mode,
  type ScanV2Offer,
  type ScanV2Status,
  type ScanV2QualityFailure,
} from './offersScanV2';
import {
  buildCheffitySyncInput,
  shouldSyncAfterPhase1Commit,
  shouldSyncAfterPhase2Commit,
  shouldSyncAfterReweImport,
} from './cheffityAutoSync';
import {
  CheckpointCorruptError,
  SCAN_V2_CHECKPOINT_VERSION,
  checkpointDisposition,
  clearCheckpoint,
  readCheckpoint,
  resolveCheckpointFile,
  resolveCheckpointScope,
  summarizeCheckpoint,
  summarizePausedMessage,
  writeCheckpointAtomic,
  type ScanV2Checkpoint,
  type ScanV2CheckpointMeta,
  type ScanV2CheckpointPhase1,
  type ScanV2CheckpointPhase2,
} from './scanV2Checkpoint';
import {
  allStoresScope,
  describeScope,
  deriveScopeFromOffers,
  normalizeScope,
  type ScanV2Scope,
} from './scanV2Scope';
import {
  addStrictBlockedKeyword,
  filterOffersStrictFood,
  getStrictFoodFilterList,
  initializeStrictFoodFilterRules,
  learnStrictFoodFeedback,
  removeStrictBlockedKeyword,
  resetStrictFoodFilterRules,
} from './offersStrictFoodFilter';
import { splitOffersByLiveWindow, classifyLiveWindow, dropExpiredFromActiveBuckets } from './snapshotLiveWindow';
import { applyFinalNonFoodGate } from './snapshotNonFoodGate';
import { reassemblePhase2Buckets } from './phase2Reassembly';
import {
  applyFoodRescuePass,
  partitionFilteredOffersForCompleteness,
  revertStaleRescues,
} from './snapshotFoodRescue';
import { summarizeFoodDecisions, evaluateFoodReconciliation } from './foodDecision';
import { dedupeOffersByContent } from './offerContentDedupe';
import {
  evaluateSnapshotSafety,
  preserveBlockedStoreOffers,
  SCAN_STORE_MINIMUMS,
} from './snapshotSafetyGate';
import {
  sanitizeSubSourceDiagnostics,
  type SubSourceDiagnostic,
  type SubSourceOutcome,
} from '../../src/services/offersIngest/subSourceDiagnostics';
import { classifyInternationalFood } from './internationalFood';
import { appConfig } from '../../src/config/env';
import { runOffersIngestPipeline } from '../../src/services/offersIngest/ingestPipeline';
import {
  OfficialSupermarketSourceConnector,
  buildKauflandCompleteness,
  getLastKauflandAnalysis,
  getLastKauflandCompleteness,
  getLastEdekaDiagnostics,
  getLastAldiNordDiagnostics,
  getLastAldiSuedDiagnostics,
  getLastNahkaufDiagnostics,
} from '../../src/services/offersIngest/sourceConnectors/officialSupermarketConnector';
import { normalizeOffers } from '../../src/services/offersIngest/normalize';
import {
  resolveImageSearchConfigFromEnv,
  type ImageSearchConfig,
} from './lidlPageOfferImageSearch';
import { replaceLidlPageImageScopeOffers, isLidlPageImageScopeOffer } from './lidlPageImageOfferScope';
import { runLidlPageImageImport } from './lidlPageOfferImport';
import { LocationFilter, Offer } from '../../src/types/models';
import { isArticleId, offersForArticleId, withArticleId } from '../../src/utils/articleIdentity';
import { classifyOfferBucket } from '../../src/utils/offerBucket';
import { classifyOfferWeekRange, type OfferWeekBucket } from '../../src/utils/offerWeek';
import { LocalMarketSourceConnector } from './localMarketConnector';
import { localMarketRegistry } from './localMarkets';
import {
  getOffersDataFile,
  loadOffersSnapshot,
  saveOffersSnapshot,
  type OfferScopeFlags,
  type OfferScopeMap,
} from './store/offersStore';
import {
  appendBackendDebugLog,
  clearBackendDebugLogs,
  readBackendDebugLogs,
} from './debug/debugLogStore';
import {
  assessReweImportQuality,
  createReweBrowserImportBookmarkletScript,
  isReweBrowserScopeOffer,
  normalizeReweBrowserImportRequest,
  renderReweBrowserImportHtml,
  replaceReweScopeOffers,
  reweBrowserImportRequestSchema,
  type ReweImportReportData,
} from './reweBrowserImport';
import {
  getManagedProcessStatus,
  getOllamaPullStatus,
  openMobileCommandConsole,
  sendManagedProcessInput,
  startOllamaPull,
  startManagedProcess,
  stopManagedProcess,
} from './system/processManager';
import {
  buildBackendRestartSpec,
  requestBackendRestart,
  requestBackendShutdown,
} from './system/backendSelfControl';

const app = express();
const port = Number(process.env.PORT ?? '8787');
const frontendUrl = process.env.APP_URL ?? 'http://localhost:5173';

// Listen-Adresse. Default ist bewusst 127.0.0.1 (nur diese Maschine).
//
// WARUM: Dieser Prozess hat KEINE Auth-Middleware und haelt gleichzeitig den
// Supabase-Service-Role-Key, der saemtliches RLS umgeht. Erreichbar sind u.a.
// /admin-v2, /api/system/backend/shutdown und /api/offers/scan-v2/start.
// `app.listen(port)` ohne Host bindet in Node an 0.0.0.0 — damit lag das
// alles offen im gesamten LAN (WLAN, Coworking, Gaeste-Netz, IoT-Geraete).
// Der Sicherheitskommentar an /admin-v2 nahm 127.0.0.1 bereits als Default an;
// der Code hat das nie eingeloest. Diese Zeile stellt die Annahme her.
//
// LAN-Entwicklung (Handy per Expo Go auf http://<PC-IP>:8787): bewusst
// aktivieren mit BIND_HOST=0.0.0.0 in der .env. Das ist nur vertretbar,
// solange du dem Netz vertraust — siehe Warnung im Startlog unten.
const bindHost = process.env.BIND_HOST ?? '127.0.0.1';
const bindIsPublic = bindHost !== '127.0.0.1' && bindHost !== 'localhost';

const locationFilterSchema = z.object({
  mode: z.enum(['none', 'postalCode', 'gps']),
  postalCode: z.string(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  radiusKm: z.number().positive(),
});

const refreshRequestSchema = z.object({
  locationFilter: locationFilterSchema.optional(),
  tryOllama: z.boolean().optional(),
  enrichWithOllama: z.boolean().optional(),
});

const aiFoodRescanRequestSchema = z.object({
  tryOllama: z.boolean().optional(),
  // Optional store-chain scope. Empty/absent = whole snapshot (old behaviour).
  storeChains: z.array(z.string().trim().min(1)).max(50).optional(),
  // Confirm a large store-less KI run over the whole snapshot. Without it, a
  // store-less run above OLLAMA_ALL_STORES_MAX_OFFERS is rejected (409).
  forceAll: z.boolean().optional(),
  // Scan strategy:
  //   - "all" (default, legacy): re-analyse every matching offer with KI.
  //   - "missing_or_uncertain": only offers whose analysis is missing/uncertain/
  //     stale/invalidated; identical products reuse one analysis. Faster.
  mode: z.enum(['all', 'missing_or_uncertain']).optional(),
  // Plan-only: compute candidate/reuse/sent-to-model counts and return them.
  // Starts NO Ollama and writes NO snapshot — safe for tests/inspection.
  dryRun: z.boolean().optional(),
  // Optional model override for this run (e.g. qwen3:14b vs llama3.1:8b) so we
  // can compare quality/speed. Empty/absent → env-configured default.
  model: z.string().trim().min(1).max(120).optional(),
});

const oneClickAiRequestSchema = z.object({
  // One-Click-KI re-ingests + KI-scans the whole snapshot — far too large for a
  // single click with a local 14B model. Require explicit confirmation.
  forceAll: z.boolean().optional(),
});

const ollamaPullRequestSchema = z.object({
  model: z.string().trim().min(1).optional(),
});

const filterKeywordRequestSchema = z.object({
  keyword: z
    .string()
    .trim()
    .min(1, 'Keyword ist erforderlich.')
    .max(120, 'Keyword ist zu lang.'),
});

const mobileInputSchema = z.object({
  input: z.string().trim().min(1).max(32),
});

const clientErrorReportSchema = z.object({
  type: z
    .enum(['error', 'unhandledrejection', 'action', 'init'])
    .optional(),
  message: z.string().trim().min(1).max(5000),
  source: z.string().trim().max(2000).optional(),
  stack: z.string().trim().max(12000).optional(),
  line: z.number().int().nonnegative().optional(),
  column: z.number().int().nonnegative().optional(),
  action: z.string().trim().max(120).optional(),
  userAgent: z.string().trim().max(600).optional(),
  href: z.string().trim().max(2000).optional(),
});

const moveOffersRequestSchema = z.object({
  offerIds: z
    .array(z.string().trim().min(1, 'offerId fehlt.'))
    .min(1, 'Mindestens eine offerId ist erforderlich.')
    .max(500, 'Zu viele offerIds in einem Request.'),
});

const defaultLocationFilter: LocationFilter = {
  mode: 'none',
  postalCode: '',
  latitude: null,
  longitude: null,
  radiusKm: 40,
};

function createStrictFilterWarning(
  removedCount: number,
  removedExamples: string[],
): string | null {
  if (removedCount <= 0) {
    return null;
  }

  const exampleText =
    removedExamples.length > 0
      ? ` Beispiele: ${removedExamples.join(', ')}`
      : '';

  return `Strenger Lebensmittel-Filter aktiv: ${removedCount} Nicht-Lebensmittel entfernt.${exampleText}`;
}

function sanitizeWarnings(warnings: string[]): string[] {
  return warnings.filter(
    (warning) =>
      !/Ollama-Enrichment gestoppt:\s*Modell/i.test(warning) &&
      !/Ollama-Enrichment gestoppt:\s*Ollama/i.test(warning),
  );
}

function normalizeHost(host: string): string {
  return host.trim().replace(/\/+$/, '');
}

function resolveOllamaHost(): string {
  const configuredHost = process.env.VITE_OLLAMA_HOST ?? 'http://localhost:11434';
  return normalizeHost(configuredHost);
}

function resolveOllamaModel(): string {
  const configuredModel = (
    process.env.VITE_OLLAMA_MODEL ?? process.env.OLLAMA_MODEL
  )?.trim();
  // Default updated 2026-05-30: Qwen 3 14B Q4_K_M fits 12 GB VRAM and is the
  // preferred local model for offer/category scans.
  return configuredModel && configuredModel.length > 0
    ? configuredModel
    : 'qwen3:14b';
}

const ollamaModelConfigSchema = z.object({
  model: z.string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, 'Ungueltiger Modellname.'),
});

async function upsertDotEnvValue(key: string, value: string): Promise<void> {
  const envPath = path.resolve(process.cwd(), '.env');
  const line = `${key}=${value}`;
  let content = '';

  try {
    content = await fsPromises.readFile(envPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw error;
    }
  }

  if (content.length === 0) {
    await fsPromises.writeFile(envPath, `${line}\n`, 'utf8');
    return;
  }

  const matcher = new RegExp(`^${key}=.*$`, 'm');
  const next = matcher.test(content)
    ? content.replace(matcher, line)
    : `${content.replace(/\s*$/, '')}\n${line}\n`;

  await fsPromises.writeFile(envPath, next, 'utf8');
}

function stringifyUnknownError(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
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

function fileTimestamp(value = new Date()): string {
  return value.toISOString().replace(/[:.]/g, '-');
}

function openExternalUrl(url: string): void {
  const args =
    process.platform === 'win32'
      ? ['/c', 'start', '', url]
      : process.platform === 'darwin'
        ? [url]
        : [url];
  const command =
    process.platform === 'win32'
      ? 'cmd'
      : process.platform === 'darwin'
        ? 'open'
        : 'xdg-open';

  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

function escapeCsvValue(value: unknown): string {
  const raw = String(value ?? '');
  if (/[",\r\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

// Augments a raw/enriched offer with the normalized deal fields the Cheffity
// mobile app reads (originalPrice, savingsPercent, nutrition, allergens, …).
// Non-destructive: existing fields are preserved, missing data becomes null/[]
// so the response shape stays consistent whether or not the AI enrichment ran.
function toApiOffer(offer: Offer): Offer & ReturnType<typeof deriveDealEnrichment> {
  const identified = withArticleId(offer);
  const enrichment = deriveDealEnrichment(
    identified as Offer & Record<string, unknown>,
    resolveEnrichmentFlags(),
  );
  return { ...identified, ...enrichment };
}

function serializeOffersForApi(offers: Offer[]): Array<ReturnType<typeof toApiOffer>> {
  return offers.map(toApiOffer);
}

function offersToCsv(offers: Offer[], now = new Date()): string {
  const header = [
    'id',
    'articleId',
    'name',
    'brand',
    'storeId',
    'storeAddress',
    'storeCity',
    'storeChain',
    'category',
    // Honest validity bucket so a "live" export is no longer silently mixed with
    // not-yet-started offers: current = active today, upcoming = starts later,
    // expired = already ended.
    'bucket',
    'price',
    'currency',
    'unit',
    'basePrice',
    'baseUnit',
    'validityStart',
    'validityEnd',
    'imageUrl',
    'sourceUrl',
    'region',
    'postalCode',
    'latitude',
    'longitude',
    'sourceScope',
    'distanceKm',
    'tags',
    'createdAt',
  ];

  const rows = offers.map((offer) =>
    [
      offer.id,
      offer.articleId ?? '',
      offer.name,
      offer.brand ?? '',
      offer.storeId ?? '',
      offer.storeAddress ?? '',
      offer.storeCity ?? '',
      offer.storeChain,
      offer.category,
      classifyOfferBucket(offer, now),
      offer.price,
      offer.currency,
      offer.unit,
      offer.basePrice ?? '',
      offer.baseUnit ?? '',
      offer.validityStart,
      offer.validityEnd,
      offer.imageUrl ?? '',
      offer.sourceUrl,
      offer.region ?? '',
      offer.postalCode ?? '',
      offer.latitude ?? '',
      offer.longitude ?? '',
      offer.sourceScope ?? '',
      offer.distanceKm ?? '',
      (offer.tags ?? []).join('|'),
      offer.createdAt,
    ]
      .map((value) => escapeCsvValue(value))
      .join(','),
  );

  return [header.join(','), ...rows].join('\n');
}

// DATEI-basierter Lifecycle-Logger (synchron, fs.appendFileSync). ECHTE URSACHE,
// warum bisher NIE ein process.lifecycle.* in den Logs stand: appendBackendDebugLog
// schreibt nur In-Memory + console.* → stdout/stderr. Im Launcher war stdout/stderr
// per Start-Process -RedirectStandardOutput in eine Datei UMGELEITET; Schreiben auf
// diese Pipe ist unter Windows ASYNCHRON und wird beim Prozessabbau nicht mehr
// geflusht. Deshalb verschwand jede Exit-/Signal-Zeile. Dieser Logger schreibt
// SYNCHRON in eine eigene Datei und ist damit unabhängig von stdout. Siehe
// lifecycleFileLog.ts. Wir kombinieren: appendBackendDebugLog (UI/Konsole) UND Datei.
const lifecycleLogFile = path.join(process.cwd(), 'backend', 'backend-lifecycle.log');
const lifecycleFileLog = createLifecycleFileLogger({ filePath: lifecycleLogFile });
const lifecycleLog = (
  level: 'info' | 'warn' | 'error',
  message: string,
  context?: Record<string, unknown>,
): void => {
  appendBackendDebugLog(level, message, context);
  lifecycleFileLog(level, message, context);
};

process.on('unhandledRejection', (reason) => {
  lifecycleLog('error', 'process.unhandledRejection', {
    reason: stringifyUnknownError(reason),
  });
});

process.on('uncaughtException', (error) => {
  lifecycleLog('error', 'process.uncaughtException', {
    message: error.message,
    stack: error.stack,
  });
});

// Strukturelle Lifecycle-Protokollierung: macht JEDE Prozessbeendigung
// nachvollziehbar (exit/beforeExit/SIGTERM/SIGINT/SIGHUP) — jetzt GARANTIERT in eine
// Datei (backend/backend-lifecycle.log), nicht nur in das flüchtige, umgeleitete
// stdout. Taucht der Prozess künftig wieder ab, steht dort GENAU, welches Ereignis
// ihn beendet hat. Bleibt die Datei stumm, war es ein harter TerminateProcess/
// SIGKILL (von JS nicht abfangbar) — dann verrät der Heartbeat (siehe unten) die
// Abbruchsekunde. Siehe auch processLifecycle.ts und den entkoppelten Launcher
// scripts/start-backend.ps1.
registerProcessLifecycleLogging(process, {
  log: lifecycleLog,
});
// Eine umgeleitete stdout/stderr-Pipe darf den Server nie an einer Log-Zeile killen.
guardStdioAgainstEpipe(
  { stdout: process.stdout, stderr: process.stderr },
  lifecycleLog,
);

// PID-Datei: erlaubt dem Launcher/Tooling die EINDEUTIGE Identifikation des
// Server-Prozesses (Health-/Port-Validierung gegen genau diese PID), unabhängig von
// fremden node-Prozessen.
try {
  fsWriteFileSync(path.join(process.cwd(), 'backend', 'backend.pid'), String(process.pid));
} catch {
  // PID-Datei ist optional — niemals am Schreiben scheitern.
}

// Unabhängiger Datei-Heartbeat (1/s, synchron). Reißt die Spur ab, kennen wir die
// Todessekunde auch ohne Signal/Exit (harter Kill). Das ref'd Intervall hält zudem
// den Event-Loop aktiv → der Prozess kann nicht still über 'beforeExit' auslaufen.
const heartbeat = startHeartbeat({
  filePath: path.join(process.cwd(), 'backend', 'backend-heartbeat.log'),
  intervalMs: 1000,
});
// Beim regulären, protokollierten Beenden den Heartbeat sauber stoppen.
process.on('exit', () => {
  heartbeat.stop();
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isOllamaReachable(host: string): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1800);

  try {
    const response = await fetch(`${host}/api/tags`, {
      method: 'GET',
      signal: controller.signal,
    });

    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function ensureOllamaReady(timeoutMs = 12000): Promise<boolean> {
  const host = resolveOllamaHost();
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const reachable = await isOllamaReachable(host);
    if (reachable) {
      return true;
    }
    await wait(450);
  }

  return false;
}

export interface OllamaRuntime {
  /** Our managed `ollama serve` process is currently running. */
  managed: boolean;
  /** The host answers /api/tags (managed OR externally started). */
  reachable: boolean;
  /** 'managed' | 'external' | 'unavailable'. */
  source: OllamaRuntimeSource;
  host: string;
}

// Snapshot the Ollama runtime: distinguishes "we run it" vs "it runs externally"
// vs "nothing answers". An externally started Ollama (reachable but not managed)
// is fully valid — the backend must not insist on its own managed process.
async function getOllamaRuntime(): Promise<OllamaRuntime> {
  const host = resolveOllamaHost();
  const managed = getManagedProcessStatus().ollama.running;
  const reachable = await isOllamaReachable(host);
  return { managed, reachable, source: classifyOllamaRuntime(managed, reachable), host };
}

/**
 * Make sure SOME Ollama is reachable, preferring whatever already runs:
 *   - already reachable (external or previously-managed) → use it, do NOT spawn
 *     a second `ollama serve` (that only fails to bind the busy port).
 *   - otherwise start our managed process and wait for it to come up.
 * Re-checks reachability after a failed managed start, so a port-in-use error
 * from a redundant spawn is reported as "läuft extern", not a hard failure.
 */
async function ensureOllamaAvailable(): Promise<
  | { ok: true; source: 'managed' | 'external' }
  | { ok: false; error: string }
> {
  const host = resolveOllamaHost();

  if (await isOllamaReachable(host)) {
    return { ok: true, source: getManagedProcessStatus().ollama.running ? 'managed' : 'external' };
  }

  const ollamaState = startManagedProcess('ollama');
  if (!ollamaState.running && ollamaState.lastError) {
    // Spawn failed — but the port may be held by an external Ollama that is
    // perfectly usable. Re-probe before declaring a hard failure.
    if (await isOllamaReachable(host)) return { ok: true, source: 'external' };
    return { ok: false, error: `Ollama konnte nicht gestartet werden: ${ollamaState.lastError}` };
  }

  if (await ensureOllamaReady()) return { ok: true, source: 'managed' };
  if (await isOllamaReachable(host)) return { ok: true, source: 'external' };
  return { ok: false, error: `Ollama ist nicht erreichbar unter ${host}. Bitte Ollama starten.` };
}

function dedupeOffersById(offers: Offer[]): Offer[] {
  const seen = new Set<string>();
  const deduped: Offer[] = [];

  for (const offer of offers) {
    if (seen.has(offer.id)) {
      continue;
    }
    seen.add(offer.id);
    deduped.push(offer);
  }

  return deduped;
}

function mergeOffersById(base: Offer[], incoming: Offer[]): Offer[] {
  return dedupeOffersById([...base, ...incoming]);
}

function moveOffersById(
  source: Offer[],
  target: Offer[],
  offerIds: string[],
): {
  nextSource: Offer[];
  nextTarget: Offer[];
  movedCount: number;
  movedOffers: Offer[];
} {
  const idSet = new Set(offerIds);
  const moved: Offer[] = [];
  const kept: Offer[] = [];

  for (const offer of source) {
    if (idSet.has(offer.id)) {
      moved.push(offer);
      continue;
    }
    kept.push(offer);
  }

  return {
    nextSource: kept,
    nextTarget: mergeOffersById(target, moved),
    movedCount: moved.length,
    movedOffers: moved,
  };
}

function classifyOfferWeek(
  offer: Pick<Offer, 'validityStart' | 'validityEnd'>,
  now = new Date(),
): OfferWeekBucket {
  const startMs = Date.parse(offer.validityStart ?? '');
  const endMs = Date.parse(offer.validityEnd ?? '');
  return classifyOfferWeekRange(
    startMs,
    endMs,
    now,
    appConfig.offerWeekMode,
    appConfig.offerMaxValidityDays,
  );
}

function splitOffersByWeek(
  offers: Offer[],
  now = new Date(),
): {
  current: Offer[];
  next: Offer[];
  other: Offer[];
} {
  const current: Offer[] = [];
  const next: Offer[] = [];
  const other: Offer[] = [];

  for (const offer of offers) {
    const bucket = classifyOfferWeek(offer, now);
    if (bucket === 'current') {
      current.push(offer);
      continue;
    }
    if (bucket === 'next') {
      next.push(offer);
      continue;
    }
    other.push(offer);
  }

  return { current, next, other };
}

type OfferSourceScope = 'national' | 'local';

const fallbackOfferScopeFlags: OfferScopeFlags = {
  national: true,
  local: true,
};

function normalizeOfferScopeFlags(
  rawScope: Partial<OfferScopeFlags> | undefined,
  fallback: OfferScopeFlags = fallbackOfferScopeFlags,
): OfferScopeFlags {
  const national = rawScope?.national === true;
  const local = rawScope?.local === true;

  if (!national && !local) {
    return { ...fallback };
  }

  return { national, local };
}

function ensureOfferScopeForId(
  offerScopes: OfferScopeMap,
  offerId: string,
  fallback: OfferScopeFlags = fallbackOfferScopeFlags,
): OfferScopeFlags {
  const id = offerId.trim();
  if (!id) {
    return { ...fallback };
  }

  const next = normalizeOfferScopeFlags(offerScopes[id], fallback);
  offerScopes[id] = next;
  return next;
}

function offerSourceScopeFromFlags(scope: OfferScopeFlags): OfferSourceScope | undefined {
  if (scope.local && !scope.national) {
    return 'local';
  }
  if (scope.national && !scope.local) {
    return 'national';
  }
  return undefined;
}

function applyOfferScopeMetadata(offer: Offer, scope: OfferScopeFlags): void {
  const sourceScope = offerSourceScopeFromFlags(scope);
  if (sourceScope) {
    offer.sourceScope = sourceScope;
    return;
  }

  delete offer.sourceScope;
}

function markOffersWithScope(
  offerScopes: OfferScopeMap,
  offers: Offer[],
  scope: OfferSourceScope,
): void {
  for (const offer of offers) {
    const entry = ensureOfferScopeForId(offerScopes, offer.id, {
      national: false,
      local: false,
    });
    entry[scope] = true;
    applyOfferScopeMetadata(offer, entry);
  }
}

function syncSnapshotOfferScopes(): void {
  const knownIds = new Set([
    ...snapshot.offers.map((offer) => offer.id),
    ...snapshot.nextWeekOffers.map((offer) => offer.id),
    ...snapshot.filteredOffers.map((offer) => offer.id),
  ]);

  const nextScopes: OfferScopeMap = {};
  for (const offerId of knownIds) {
    nextScopes[offerId] = normalizeOfferScopeFlags(
      snapshot.offerScopes[offerId],
      fallbackOfferScopeFlags,
    );
  }

  snapshot.offerScopes = nextScopes;
  for (const offer of [
    ...snapshot.offers,
    ...snapshot.nextWeekOffers,
    ...snapshot.filteredOffers,
  ]) {
    applyOfferScopeMetadata(offer, snapshot.offerScopes[offer.id] ?? fallbackOfferScopeFlags);
  }
}

function buildOfferScopesFromScopedOffers(
  scopedOffers: Array<{ scope: OfferSourceScope; offers: Offer[] }>,
): OfferScopeMap {
  const offerScopes: OfferScopeMap = {};

  for (const scoped of scopedOffers) {
    markOffersWithScope(offerScopes, scoped.offers, scoped.scope);
  }

  return offerScopes;
}

function mergeOfferScopeMaps(base: OfferScopeMap, incoming: OfferScopeMap): OfferScopeMap {
  const merged: OfferScopeMap = { ...base };

  for (const [offerId, scope] of Object.entries(incoming)) {
    const entry = ensureOfferScopeForId(merged, offerId, {
      national: false,
      local: false,
    });
    if (scope.national) {
      entry.national = true;
    }
    if (scope.local) {
      entry.local = true;
    }
  }

  return merged;
}

function countOffersByScope(offers: Offer[]): {
  total: number;
  national: number;
  local: number;
  both: number;
} {
  let national = 0;
  let local = 0;
  let both = 0;

  for (const offer of offers) {
    const scope = normalizeOfferScopeFlags(snapshot.offerScopes[offer.id]);
    if (scope.national) {
      national += 1;
    }
    if (scope.local) {
      local += 1;
    }
    if (scope.national && scope.local) {
      both += 1;
    }
  }

  return {
    total: offers.length,
    national,
    local,
    both,
  };
}

function getOfferScopeSummary(): {
  live: {
    total: number;
    national: number;
    local: number;
    both: number;
  };
  nextWeek: {
    total: number;
    national: number;
    local: number;
    both: number;
  };
  filtered: {
    total: number;
    national: number;
    local: number;
    both: number;
  };
} {
  return {
    live: countOffersByScope(snapshot.offers),
    nextWeek: countOffersByScope(snapshot.nextWeekOffers),
    filtered: countOffersByScope(snapshot.filteredOffers),
  };
}

function getLocalSourceSummary(): Array<{
  storeId: string;
  displayName: string;
  address: string;
  postalCode: string;
  city: string;
  active: boolean;
  scraperType: string;
  radiusKm: number;
}> {
  return localMarketRegistry.map((market) => ({
    storeId: market.storeId,
    displayName: market.displayName,
    address: market.address,
    postalCode: market.postalCode,
    city: market.city,
    active: market.active,
    scraperType: market.scraperType,
    radiusKm: market.radiusKm,
  }));
}

function applySnapshotWeekSplit(offers: Offer[]): {
  liveCount: number;
  nextWeekCount: number;
  droppedCount: number;
} {
  const deduped = dedupeOffersById(offers);
  const split = splitOffersByWeek(deduped);
  snapshot.offers = split.current;
  snapshot.nextWeekOffers = split.next;

  return {
    liveCount: split.current.length,
    nextWeekCount: split.next.length,
    droppedCount: split.other.length,
  };
}

function applyCategorizedOffersToSnapshot(categorization: {
  offers: Offer[];
  filteredOffers: Offer[];
}): {
  liveCount: number;
  nextWeekCount: number;
  droppedCount: number;
  strictRemovedCount: number;
  strictRemovedExamples: string[];
} {
  const strictFilterResult = filterOffersStrictFood(categorization.offers);
  const weekSplit = applySnapshotWeekSplit(strictFilterResult.offers);
  snapshot.filteredOffers = dedupeOffersById([
    ...categorization.filteredOffers,
    ...strictFilterResult.removedOffers,
  ]);

  return {
    ...weekSplit,
    strictRemovedCount: strictFilterResult.removedCount,
    strictRemovedExamples: strictFilterResult.removedExamples,
  };
}

/**
 * Finaler Non-Food-Gate als Sicherheitsnetz auf den IN-MEMORY-Snapshot:
 * egal über welchen Pfad die Buckets zuletzt verändert wurden (Scan 1.0/2.0,
 * KI-Rescan, manueller Import, Boot) — starkes Non-Food wird VOR jedem
 * Persistieren aus `offers`/`nextWeekOffers` nach `filteredOffers` repariert.
 * Idempotent und nur bei Treffern sichtbar (Warnung + Debug-Log).
 */
function repairSnapshotNonFood(): number {
  const gate = applyFinalNonFoodGate({
    offers: snapshot.offers,
    nextWeekOffers: snapshot.nextWeekOffers,
    filteredOffers: snapshot.filteredOffers,
  });
  if (gate.movedCount === 0) {
    return 0;
  }
  snapshot.offers = gate.offers;
  snapshot.nextWeekOffers = gate.nextWeekOffers;
  snapshot.filteredOffers = gate.filteredOffers;
  appendBackendDebugLog('warn', 'offers.nonFoodGate.repaired', {
    movedCount: gate.movedCount,
    examples: gate.movedExamples,
  });
  snapshot.warnings = sanitizeWarnings([
    ...snapshot.warnings.filter((warning) => !warning.startsWith('Non-Food-Gate:')),
    `Non-Food-Gate: ${gate.movedCount} Angebot(e) mit klarem Non-Food-Signal aus Live/Naechste-Woche nach Filtered verschoben (z. B. ${gate.movedExamples
      .slice(0, 4)
      .join(', ')}).`,
  ]);
  return gate.movedCount;
}

/**
 * Finaler Food-Rescue-Pass als Gegenstück zum Non-Food-Gate: echte Lebensmittel,
 * die fälschlich in `filteredOffers` gelandet sind (Modell-Fehlverdikt wie der
 * Kaufland-Fall "offizielle Food-Angebote im Filtered-Bucket"), werden NACH der
 * Non-Food-Reparatur und VOR jedem Persistieren regelbasiert zurück in die
 * sichtbaren Buckets verschoben — für alle Shops, KW-unabhängig über die
 * vorhandene Gültigkeits-/Wochenlogik. Unsichere Fälle werden nie blind
 * gerettet, sondern reviewNeeded markiert (sichtbar im Scan-Report).
 */
function rescueSnapshotFood(): number {
  const rescue = applyFoodRescuePass(
    {
      offers: snapshot.offers,
      nextWeekOffers: snapshot.nextWeekOffers,
      filteredOffers: snapshot.filteredOffers,
    },
    {
      weekBucketOf: (offer) => classifyOfferWeek(offer),
      maxValidityDays: appConfig.offerMaxValidityDays,
    },
  );
  snapshot.offers = rescue.offers;
  snapshot.nextWeekOffers = rescue.nextWeekOffers;
  snapshot.filteredOffers = rescue.filteredOffers;
  if (rescue.rescuedCount === 0) {
    return 0;
  }
  appendBackendDebugLog('warn', 'offers.foodRescue.applied', {
    rescuedCount: rescue.rescuedCount,
    rescuedToCurrentCount: rescue.rescuedToCurrentCount,
    rescuedToNextCount: rescue.rescuedToNextCount,
    reviewNeededCount: rescue.reviewNeededCount,
    examples: rescue.rescuedExamples,
  });
  snapshot.warnings = sanitizeWarnings([
    ...snapshot.warnings.filter((warning) => !warning.startsWith('Food-Rescue:')),
    `Food-Rescue: ${rescue.rescuedCount} Lebensmittel-Angebot(e) aus Filtered zurück in den sichtbaren Feed verschoben ` +
      `(${rescue.rescuedToCurrentCount} Live, ${rescue.rescuedToNextCount} Naechste-Woche; z. B. ${rescue.rescuedExamples
        .slice(0, 4)
        .join(', ')}).`,
  ]);
  return rescue.rescuedCount;
}

/**
 * Fragment-Gate als Sicherheitsnetz auf den IN-MEMORY-Snapshot (Gegenstück zu
 * repairSnapshotNonFood für Namen statt Food-Signale): hart schlechte Namen
 * ("l-Dose", "Tiefpreis", reine Beschreibungszeilen) werden VOR jedem
 * Persistieren aus `offers`/`nextWeekOffers` in die Quarantäne
 * (`filteredOffers`, name_fragment + reviewNeeded) verschoben — auch bei einem
 * bereits persistierten Snapshot mit Fragment-Leaks. Idempotent.
 */
function repairSnapshotFragments(): number {
  const gate = applyFragmentQuarantineGate({
    offers: snapshot.offers,
    nextWeekOffers: snapshot.nextWeekOffers,
    filteredOffers: snapshot.filteredOffers,
  });
  // Auch ohne Bucket-Wechsel persistieren, wenn ein bereits gefiltertes Name-Quality-
  // Fragment nur strukturell normalisiert (der „kernarm"-Snapshot-Repro) oder ein
  // falsch quarantänisiertes echtes Produkt denormalisiert wurde.
  if (gate.movedCount === 0 && gate.normalizedCount === 0 && gate.repairedCount === 0) {
    return 0;
  }
  snapshot.offers = gate.offers;
  snapshot.nextWeekOffers = gate.nextWeekOffers;
  snapshot.filteredOffers = gate.filteredOffers;
  appendBackendDebugLog('warn', 'offers.fragmentGate.repaired', {
    movedCount: gate.movedCount,
    examples: gate.movedExamples,
    normalizedCount: gate.normalizedCount,
    normalizedExamples: gate.normalizedExamples,
    repairedCount: gate.repairedCount,
    repairedExamples: gate.repairedExamples,
  });
  const fragmentParts: string[] = [];
  if (gate.movedCount > 0) {
    fragmentParts.push(
      `${gate.movedCount} Angebot(e) mit Fragment-/Promo-Namen aus Live/Naechste-Woche in die Quarantäne verschoben (z. B. ${gate.movedExamples
        .slice(0, 4)
        .join(', ')})`,
    );
  }
  if (gate.normalizedCount > 0) {
    fragmentParts.push(
      `${gate.normalizedCount} gefiltertes Name-Quality-Fragment normalisiert (z. B. ${gate.normalizedExamples
        .slice(0, 4)
        .join(', ')})`,
    );
  }
  if (gate.repairedCount > 0) {
    fragmentParts.push(
      `${gate.repairedCount} falsch quarantänisiertes Ein-Wort-Produkt denormalisiert (z. B. ${gate.repairedExamples
        .slice(0, 4)
        .join(', ')})`,
    );
  }
  snapshot.warnings = sanitizeWarnings([
    ...snapshot.warnings.filter((warning) => !warning.startsWith('Fragment-Gate:')),
    `Fragment-Gate: ${fragmentParts.join('; ')}.`,
  ]);
  return gate.movedCount + gate.normalizedCount + gate.repairedCount;
}

/**
 * Stale-Rescue-Reconciliation (Task P3): ein früher (fälschlich) geretteter
 * Eintrag (food_rescue-Tag), der nicht mehr confirmed_food ist — etwa ein
 * mehrdeutiger Einwortname ohne starke strukturierte Belege — wird VOR dem
 * Non-Food-Gate/Rescue wieder in den Filter (reviewNeeded) verschoben. Der
 * Audit-Tag ist nie ein dauerhafter Food-Beweis. Idempotent.
 */
function revertStaleSnapshotRescues(): number {
  const result = revertStaleRescues({
    offers: snapshot.offers,
    nextWeekOffers: snapshot.nextWeekOffers,
    filteredOffers: snapshot.filteredOffers,
  });
  if (result.revertedCount === 0) {
    return 0;
  }
  snapshot.offers = result.offers;
  snapshot.nextWeekOffers = result.nextWeekOffers;
  snapshot.filteredOffers = result.filteredOffers;
  appendBackendDebugLog('warn', 'offers.staleRescue.reverted', {
    revertedCount: result.revertedCount,
    examples: result.revertedExamples,
  });
  snapshot.warnings = sanitizeWarnings([
    ...snapshot.warnings.filter((warning) => !warning.startsWith('Rescue-Reconciliation:')),
    `Rescue-Reconciliation: ${result.revertedCount} früher geretteter Eintrag/-Einträge ohne aktuellen confirmed_food-Beleg zurück in den Filter (Review) verschoben (z. B. ${result.revertedExamples
      .slice(0, 4)
      .join(', ')}).`,
  ]);
  return result.revertedCount;
}

/**
 * Qualitäts-Invariante NACH der Finalisierung (Task „Qualitäts-Gate"): nach
 * Gate + Rescue darf KEIN zeitlich gültiges confirmed_food mehr im Filter liegen
 * (der Rescue rettet jedes gültige confirmed_food, also ist das strukturell 0).
 * Ein Rest ist ein echter Reconciliation-Bug und wird LAUT als Warnung
 * ausgewiesen (kein Throw im Hot-Save-Pfad). uncertain bleibt bewusst nur eine
 * Warnung und blockiert nie. Idempotent.
 */
function assertFoodReconciliationComplete(): void {
  const summary = summarizeFoodDecisions(
    {
      offers: snapshot.offers,
      nextWeekOffers: snapshot.nextWeekOffers,
      filteredOffers: snapshot.filteredOffers,
    },
    { isTimeValid: (offer) => classifyLiveWindow(offer, new Date(), appConfig.offerMaxValidityDays) !== 'other' },
  );
  const tag = 'Qualitaets-Gate:';
  const withoutPrior = snapshot.warnings.filter((warning) => !warning.startsWith(tag));
  if (summary.wrongFoodFilteredCount > 0) {
    appendBackendDebugLog('error', 'offers.reconciliation.foodLeftInFilter', {
      count: summary.wrongFoodFilteredCount,
      examples: summary.wrongFoodFilteredExamples,
    });
    snapshot.warnings = sanitizeWarnings([
      ...withoutPrior,
      `${tag} 🔴 ${summary.wrongFoodFilteredCount} zeitlich gültige(s) confirmed_food-Angebot(e) verbleiben im Filter ` +
        `(z. B. ${summary.wrongFoodFilteredExamples.slice(0, 4).join(', ')}) — Reconciliation unvollständig.`,
    ]);
  } else {
    snapshot.warnings = withoutPrior;
  }
}

interface SaveSnapshotOptions {
  /** Scan-Commit: blockiert das Persistieren, wenn nach der vollständigen
   *  Reconciliation (Fragment-Gate + Non-Food-Gate + Food-Rescue) noch zeitlich
   *  gültiges confirmed_food im Filter liegt — wirft ScanQualityGateError VOR
   *  jedem Schreiben, der alte Snapshot bleibt also erhalten. Default false, damit
   *  Boot-Repair und Hot-Saves (manuelle Edits) nie aus diesem Grund werfen. */
  enforceFoodReconciliation?: boolean;
  /** Aktiver Shop-Scope dieses Commits (begrenzt den Reconciliation-Check auf die
   *  Shops des Laufs). Default: aktiver Scan-Scope bzw. all_stores. */
  scope?: ScanV2Scope;
}

/**
 * Inhaltliche Angebots-Dedupe (Task P3, „Auslese"-Fall): dasselbe Wochenangebot
 * landet manchmal mehrfach mit verschiedenen ids im selben Bucket (zwei Scrape-
 * Läufe, zwei Quell-Slugs). Pro Bucket werden Einträge mit identischem
 * normalisiertem Angebots-Fingerprint (Shop, Name, Preis, Gültigkeit, Quelle,
 * Einheit) zusammengeführt — UNTERSCHIEDLICHE echte Wochenangebote (andere
 * Gültigkeit/Preis) bleiben getrennt. Idempotent; nur bei Treffern sichtbar.
 */
function dedupeSnapshotContent(): number {
  const current = dedupeOffersByContent(snapshot.offers);
  const next = dedupeOffersByContent(snapshot.nextWeekOffers);
  const filtered = dedupeOffersByContent(snapshot.filteredOffers);
  const removedCount = current.removedCount + next.removedCount + filtered.removedCount;
  if (removedCount === 0) {
    return 0;
  }
  snapshot.offers = current.offers;
  snapshot.nextWeekOffers = next.offers;
  snapshot.filteredOffers = filtered.offers;
  const examples = [
    ...new Set([...current.removedExamples, ...next.removedExamples, ...filtered.removedExamples]),
  ].slice(0, 8);
  appendBackendDebugLog('warn', 'offers.contentDedupe.applied', { removedCount, examples });
  snapshot.warnings = sanitizeWarnings([
    ...snapshot.warnings.filter((warning) => !warning.startsWith('Dedupe:')),
    `Dedupe: ${removedCount} inhaltliche(s) Angebots-Duplikat(e) entfernt (gleicher Shop/Name/Preis/Gültigkeit; z. B. ${examples
      .slice(0, 4)
      .join(', ')}).`,
  ]);
  return removedCount;
}

/**
 * Snapshot-Datumshygiene als Sicherheitsnetz auf den IN-MEMORY-Snapshot
 * (Gegenstück zu repairSnapshotNonFood/-Fragments für Gültigkeit statt Inhalt):
 * abgelaufene Angebote (valid_to vor heute, Europe/Berlin über die zentrale
 * classifyLiveWindow-Logik) werden VOR jedem Persistieren aus `offers`/
 * `nextWeekOffers` entfernt — auch aus einem bereits persistierten Snapshot mit
 * abgelaufenen current-Angeboten (der nahkauf-„22 expired"-Drift). Generisch für
 * ALLE Shops, KEINE Shop-/KW-/Produkt-Sonderlogik; `filteredOffers` bleiben
 * unberührt. Idempotent.
 */
function repairSnapshotExpired(): number {
  const result = dropExpiredFromActiveBuckets(
    {
      offers: snapshot.offers,
      nextWeekOffers: snapshot.nextWeekOffers,
      filteredOffers: snapshot.filteredOffers,
    },
    { now: new Date(), maxValidityDays: appConfig.offerMaxValidityDays },
  );
  if (result.removedCount === 0) {
    return 0;
  }
  snapshot.offers = result.offers;
  snapshot.nextWeekOffers = result.nextWeekOffers;
  snapshot.filteredOffers = result.filteredOffers;
  appendBackendDebugLog('warn', 'offers.expiredGate.repaired', {
    removedCount: result.removedCount,
    examples: result.removedExamples,
  });
  snapshot.warnings = sanitizeWarnings([
    ...snapshot.warnings.filter((warning) => !warning.startsWith('Expired-Gate:')),
    `Expired-Gate: ${result.removedCount} abgelaufene(s) Angebot(e) (valid_to vor heute) aus Live/Naechste-Woche entfernt (z. B. ${result.removedExamples
      .slice(0, 4)
      .join(', ')}).`,
  ]);
  return result.removedCount;
}

/**
 * Policy-Gate: per Policy DEAKTIVIERTE Shops (ALDI SÜD/NORD, Lidl) dürfen in
 * KEINEM Persistenzpfad als aktive Angebote im Snapshot landen. Egal über welchen
 * Weg ihre Angebote hineingekommen sind (alter persistierter Snapshot, Cache,
 * lokale Quelle, manueller Import) — VOR jedem Speichern und beim Boot werden sie
 * generisch (nur über storeChain) aus offers/nextWeek/filtered entfernt.
 * Idempotent: ein Snapshot ohne deaktivierte Shops bleibt unverändert.
 */
function purgeSnapshotDisabledStores(): number {
  const disabled = parseDisabledStores(appConfig.offersDisabledStores);
  const result = purgeDisabledFromBuckets(
    {
      offers: snapshot.offers,
      nextWeekOffers: snapshot.nextWeekOffers,
      filteredOffers: snapshot.filteredOffers,
    },
    disabled,
  );
  if (result.removedCount === 0) {
    return 0;
  }
  snapshot.offers = result.offers;
  snapshot.nextWeekOffers = result.nextWeekOffers;
  snapshot.filteredOffers = result.filteredOffers;
  appendBackendDebugLog('warn', 'offers.disabledStores.purged', {
    removedCount: result.removedCount,
    removedByStore: result.removedByStore,
    examples: result.removedExamples,
  });
  snapshot.warnings = sanitizeWarnings([
    ...snapshot.warnings.filter((warning) => !warning.startsWith('Deaktivierte-Shops:')),
    `Deaktivierte-Shops: ${result.removedCount} Angebot(e) von bewusst deaktivierten Shops ` +
      `(${Object.keys(result.removedByStore).join(', ')}) aus dem Snapshot entfernt — ` +
      `unsichere Quelle, bewusst nicht gescannt (kein Fehler).`,
  ]);
  return result.removedCount;
}

async function saveSnapshot(options: SaveSnapshotOptions = {}): Promise<void> {
  dedupeSnapshotContent();
  // Policy-Purge ZUERST: deaktivierte Shops fliegen raus, bevor die Qualitäts-
  // gates über den verbleibenden Bestand laufen.
  purgeSnapshotDisabledStores();
  repairSnapshotFragments();
  revertStaleSnapshotRescues();
  repairSnapshotNonFood();
  rescueSnapshotFood();
  // Datumshygiene NACH Gate/Rescue (die nur zwischen Buckets verschieben): ein
  // abgelaufenes Angebot darf in KEINEM Persistenzpfad in current/next bleiben.
  repairSnapshotExpired();
  // Idempotente Diagnose-Warnung (nie blockierend) — auch für Boot/Hot-Save.
  assertFoodReconciliationComplete();
  // Blockierendes Pre-Commit-Gate NUR im Scan-Commit-Kontext (Task P1): nach
  // Gate + Rescue darf KEIN zeitlich gültiges confirmed_food mehr im Filter
  // liegen. Verbleibt eines, ist die Reconciliation unvollständig — der Commit
  // wird VOR saveOffersSnapshot abgebrochen (kein partieller Snapshot, alter
  // Snapshot bleibt erhalten). Scope-bewusst: ein Phase-2-only-Lauf prüft nur
  // seine Shops. uncertain/abgelaufenes Food/Fragment/Lock blockieren nie.
  if (options.enforceFoodReconciliation) {
    const reconciliation = evaluateFoodReconciliation(
      { filteredOffers: snapshot.filteredOffers },
      {
        scope: options.scope ?? scanV2State.scope ?? allStoresScope(),
        isTimeValid: (offer) =>
          classifyLiveWindow(offer, new Date(), appConfig.offerMaxValidityDays) !== 'other',
      },
    );
    if (!reconciliation.ok) {
      appendBackendDebugLog('error', 'offers.reconciliation.commitBlocked', {
        failedChecks: reconciliation.failedChecks,
        count: reconciliation.wrongFoodFilteredCount,
        examples: reconciliation.wrongFoodFilteredExamples,
      });
      throw new ScanQualityGateError(
        reconciliation.reasons,
        reconciliation.failedChecks,
        reconciliation.wrongFoodFilteredExamples,
      );
    }
  }
  syncSnapshotOfferScopes();
  await saveOffersSnapshot(snapshot);
  // Snapshot hat sich geändert → der nächste scan-report wird frisch gebaut
  // (sonst lieferte der TTL-Cache kurzzeitig veraltete Zahlen).
  invalidateScanReportCache();
}

// Startup timing — printed to the backend console so a slow restart can be
// pinpointed at a glance (snapshot load vs. process/transpile overhead).
// `process.uptime()` is seconds since the Node process started, so it captures
// the tsx/esbuild transpile + dependency-load cost that happens before this.
const __bootStart = Date.now();
console.log(`[AIChef Backend] Modul-Init nach ${(process.uptime() * 1000).toFixed(0)} ms (tsx/deps).`);

const __t0 = Date.now();
const snapshot = await loadOffersSnapshot();
console.log(`[AIChef Backend] Snapshot geladen in ${Date.now() - __t0} ms (${snapshot.offers.length}+${snapshot.nextWeekOffers.length}+${snapshot.filteredOffers.length} Angebote).`);
const startupWeekSplit = applySnapshotWeekSplit([
  ...snapshot.offers,
  ...snapshot.nextWeekOffers,
]);
snapshot.warnings = sanitizeWarnings(snapshot.warnings);
if (startupWeekSplit.droppedCount > 0) {
  snapshot.warnings = sanitizeWarnings([
    ...snapshot.warnings,
    `Hinweis: ${startupWeekSplit.droppedCount} Angebot(e) wurden beim Start verworfen (weder diese noch naechste Woche).`,
  ]);
}
// Filterregeln VOR dem Boot-Gate/-Rescue laden, damit menschliche
// Entscheidungen (learned allow/block) von beiden Reparatur-Pässen von Anfang
// an respektiert werden.
const __tFilter = Date.now();
await initializeStrictFoodFilterRules();
console.log(`[AIChef Backend] Filterregeln geladen in ${Date.now() - __tFilter} ms.`);
// Policy-Purge auch beim Boot: ein bereits persistierter Snapshot mit Angeboten
// von bewusst deaktivierten Shops (ALDI SÜD/NORD, Lidl) wird beim Start sofort
// bereinigt — so kann nach dem Deaktivieren keine unsichere Altlast über einen
// Neustart hinweg in App/Cheffity sichtbar bleiben.
const startupDisabledPurged = purgeSnapshotDisabledStores();
if (startupDisabledPurged > 0) {
  console.log(
    `[AIChef Backend] Deaktivierte-Shops beim Start: ${startupDisabledPurged} Angebot(e) aus dem Snapshot entfernt.`,
  );
}
// Fragment-Gate auch beim Boot: ein bereits persistierter Snapshot mit
// Fragment-Leaks ("l-Dose") in current/next wird beim Start sofort repariert.
const startupFragmentsRepaired = repairSnapshotFragments();
if (startupFragmentsRepaired > 0) {
  console.log(
    `[AIChef Backend] Fragment-Gate beim Start: ${startupFragmentsRepaired} Angebot(e) in die Quarantäne verschoben.`,
  );
}
// Finaler Non-Food-Gate auch beim Boot: ein bereits persistierter Snapshot mit
// Non-Food-Leaks in current/next wird beim Start sofort repariert.
const startupNonFoodRepaired = repairSnapshotNonFood();
if (startupNonFoodRepaired > 0) {
  console.log(
    `[AIChef Backend] Non-Food-Gate beim Start: ${startupNonFoodRepaired} Angebot(e) nach Filtered verschoben.`,
  );
}
// Food-Rescue auch beim Boot: ein persistierter Snapshot mit fälschlich
// gefilterten Lebensmitteln wird beim Start sofort repariert.
const startupFoodRescued = rescueSnapshotFood();
if (startupFoodRescued > 0) {
  console.log(
    `[AIChef Backend] Food-Rescue beim Start: ${startupFoodRescued} Angebot(e) zurück in den sichtbaren Feed verschoben.`,
  );
}
// Expired-Gate auch beim Boot: ein bereits persistierter Snapshot mit
// abgelaufenen current-Angeboten (valid_to vor heute) wird beim Start sofort
// bereinigt — so kann der Drift „expired in current" nie über einen Neustart
// hinweg bestehen bleiben.
const startupExpiredRemoved = repairSnapshotExpired();
if (startupExpiredRemoved > 0) {
  console.log(
    `[AIChef Backend] Expired-Gate beim Start: ${startupExpiredRemoved} abgelaufene Angebot(e) aus Live/Naechste-Woche entfernt.`,
  );
}
syncSnapshotOfferScopes();
// Persist the startup re-split, but do NOT block server startup on a 3.2 MB+
// disk write — nothing else writes the snapshot at boot, so a fire-and-forget
// save is race-free and shaves the write off the path to app.listen().
void saveOffersSnapshot(snapshot).catch((error) => {
  appendBackendDebugLog('error', 'snapshot.startupSave.failed', {
    error: error instanceof Error ? error.message : String(error),
  });
});
console.log(`[AIChef Backend] Startup-Arbeit gesamt: ${Date.now() - __bootStart} ms.`);

// Opt-in cleanup of leftover backend/data/categorizer-runs/<run> temp dirs from
// crashed, hard-killed, or pre-cancellation runs. Disabled by default (0) so we
// never delete a user's artifacts unasked; set CATEGORIZER_RUNS_CLEANUP_DAYS to
// a positive number of days to prune dirs older than that on startup.
{
  const cleanupDays = Number(process.env.CATEGORIZER_RUNS_CLEANUP_DAYS ?? '0');
  if (Number.isFinite(cleanupDays) && cleanupDays > 0) {
    void cleanupStaleCategorizerRuns(cleanupDays * 24 * 60 * 60 * 1000)
      .then((removed) => {
        if (removed.length > 0) {
          appendBackendDebugLog('info', 'categorizerRuns.cleanup', {
            removedCount: removed.length,
            removed,
          });
        }
      })
      .catch(() => undefined);
  }
}

const ingestState: {
  running: boolean;
  message: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
} = {
  running: false,
  message: 'idle',
  startedAt: null,
  finishedAt: null,
  lastError: null,
};

// Separate, manual, on-demand import: reads Lidl's Prospekt-BILDSEITEN (the
// pure flyer page images that carry the actual Frische-/Lebensmittelangebote —
// `flyer.products` is almost entirely Wein/Spirituosen/Non-Food, see
// the development log) via OCR/Vision, then looks up a real product photo
// per offer via Google Custom Search instead of using the shared flyer-page
// image. Deliberately NOT part of the automatic weekly scan (that stays
// 'off'/'off' for OCR/Vision, unchanged) — this can take several minutes
// (OCR/Vision per page + one image search per product), so it runs as its own
// background job, same shape as ingestState/aiRescanState.
const lidlPageImageImportState: {
  running: boolean;
  message: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  lastResult: {
    candidatesFound: number;
    searched: number;
    replacedWithSearchImage: number;
    keptFallbackPageImage: number;
    searchErrors: number;
    dryRun: boolean;
  } | null;
} = {
  running: false,
  message: 'idle',
  startedAt: null,
  finishedAt: null,
  lastError: null,
  lastResult: null,
};

// Per-run metrics for the incremental ("missing_or_uncertain") mode so /status +
// admin-v2 can show what the fast path actually skipped/reused. Null in classic
// "all" runs. Critically, `sentToModel` (attempted) is kept separate from
// `classifiedByAi` (real KI hits) and `fallbackOnly` (rule fallback) so the UI
// can never claim "X per KI" when the model produced nothing.
interface SelectiveRescanStats {
  /** Offers selected as missing/uncertain/stale candidates. */
  candidatesSelected: number;
  /** Distinct products actually sent to the model (representatives). */
  sentToModel: number;
  /** Of those, how many the model really classified (LLM reasons present). */
  classifiedByAi: number;
  /** Of those, how many fell back to rules only (no real KI). */
  fallbackOnly: number;
  /** Candidates filled from a sibling product's analysis (no model). */
  reusedProductAnalysis: number;
  /** Skipped because already good + current. */
  skippedUpToDate: number;
  /** Skipped because editorially locked (never overwritten). */
  skippedLocked: number;
  /** Offers still uncertain after the run. */
  uncertainRemaining: number;
  /** Items the model timed out on (Ollama alive) and skipped. */
  timedOutItems: number;
  /** Of those, how many became reviewNeeded with reason `ai_timeout`. */
  reviewNeededFromTimeout: number;
  /** Items corrected + flagged reviewNeeded due to a keyword↔category conflict. */
  conflictRejected: number;
  /** Title of the last item that timed out (diagnostic). */
  lastTimedOutOfferName: string | null;
  /** Last transport-level Ollama error (diagnostic). */
  lastOllamaError: string | null;
}

const aiRescanState: {
  running: boolean;
  total: number;
  processed: number;
  message: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  scannedCount: number;
  aiClassifiedCount: number;
  fallbackCount: number;
  // Store-scope info so /status + admin-v2 can show what is being processed.
  scopeType: 'all' | 'stores';
  storeChains: string[];
  // Which scan strategy this run uses (legacy full vs. incremental).
  mode: 'all' | 'missing_or_uncertain';
  // Incremental-mode metrics; null for a classic full run.
  selective: SelectiveRescanStats | null;
  // Wall-clock duration of the last finished run (ms) for the comparison KPIs.
  durationMs: number | null;
  // Preflight heads-up (e.g. smoke soft-pass while model GPU-resident).
  preflightWarning: string | null;
} = {
  running: false,
  total: 0,
  processed: 0,
  message: 'idle',
  startedAt: null,
  finishedAt: null,
  lastError: null,
  scannedCount: 0,
  aiClassifiedCount: 0,
  fallbackCount: 0,
  scopeType: 'all',
  storeChains: [],
  mode: 'all',
  selective: null,
  durationMs: null,
  preflightWarning: null,
};

// Compact record of the last finished run of each mode, so admin-v2 can show a
// side-by-side comparison ("letzter Vollscan" vs. "letzter neuer Scan"). Only
// genuine completions are recorded (a fallback-only run aborts via the Zero-AI
// guard and never reaches the recorder), so the comparison never counts a
// non-KI run as a KI run.
const lastAiRescanByMode: {
  all: { at: string; durationMs: number; scannedCount: number; aiClassifiedCount: number } | null;
  missing_or_uncertain:
    | {
        at: string;
        durationMs: number;
        sentToModel: number;
        classifiedByAi: number;
        reusedProductAnalysis: number;
        skipped: number;
      }
    | null;
} = { all: null, missing_or_uncertain: null };

let aiRescanBackgroundTask: Promise<void> | null = null;
// Abort handle for the running KI-Rescan so /cancel can kill the Python child,
// not just flip a UI flag. Null when no rescan is in flight.
let aiRescanAbortController: AbortController | null = null;

// Tracks the last manual Supabase sync so /admin-v2 can show it as a KPI.
// Background syncs (if added later) can write to this same slot.
const lastSupabaseSyncState: {
  at: string | null;
  status: 'ok' | 'error' | null;
  upserted: number | null;
  errors: number | null;
} = { at: null, status: null, upserted: null, errors: null };

// Tracks the last deal⇄recipe-ingredient matcher run (auto after sync OR manual
// via /api/cheffity/match-deals) so the Cheffity offer-quality endpoint can show
// it. In-memory only — status is `null`/"never" after a backend restart.
const lastRecipeMatchState: {
  at: string | null;
  status: 'ok' | 'error' | null;
  candidateMatches: number | null;
  writtenMatches: number | null;
  recipesWithMatches: number | null;
  errors: number | null;
  durationMs: number | null;
} = {
  at: null,
  status: null,
  candidateMatches: null,
  writtenMatches: null,
  recipesWithMatches: null,
  errors: null,
  durationMs: null,
};

function recordRecipeMatchState(
  result: Awaited<ReturnType<typeof runDealRecipeMatch>>,
): void {
  // dryRun runs do not write, so they must not overwrite the "last write" KPIs.
  if (result.dryRun) return;
  lastRecipeMatchState.at = new Date().toISOString();
  lastRecipeMatchState.status = result.errors.length === 0 ? 'ok' : 'error';
  lastRecipeMatchState.candidateMatches = result.candidateMatches;
  lastRecipeMatchState.writtenMatches = result.writtenMatches;
  lastRecipeMatchState.recipesWithMatches = result.recipesWithMatches;
  lastRecipeMatchState.errors = result.errors.length;
  lastRecipeMatchState.durationMs = result.durationMs;
}

/**
 * Run the deal⇄recipe-ingredient matcher after a deals-sync. Fail-soft: it
 * never throws into the sync caller — any problem is logged. Returns the result
 * (or null if not configured/failed) so a manual endpoint can surface it in its
 * API response.
 */
async function runDealRecipeMatchSafe(
  trigger: string,
): Promise<Awaited<ReturnType<typeof runDealRecipeMatch>> | null> {
  if (!isDealMatcherConfigured()) {
    appendBackendDebugLog('warn', 'cheffity.dealMatch.notConfigured', { trigger });
    return null;
  }
  try {
    const matchResult = await runDealRecipeMatch();
    recordRecipeMatchState(matchResult);
    appendBackendDebugLog('info', 'cheffity.dealMatch.completed', {
      trigger,
      scannedDeals: matchResult.scannedDeals,
      scannedIngredients: matchResult.scannedIngredients,
      candidateMatches: matchResult.candidateMatches,
      writtenMatches: matchResult.writtenMatches,
      deletedExpiredMatches: matchResult.deletedExpiredMatches,
      recipesWithMatches: matchResult.recipesWithMatches,
      errorsCount: matchResult.errors.length,
      durationMs: matchResult.durationMs,
    });
    return matchResult;
  } catch (matchError) {
    lastRecipeMatchState.at = new Date().toISOString();
    lastRecipeMatchState.status = 'error';
    lastRecipeMatchState.errors = (lastRecipeMatchState.errors ?? 0) + 1;
    appendBackendDebugLog('error', 'cheffity.dealMatch.failed', {
      trigger,
      error: matchError instanceof Error ? matchError.message : String(matchError),
    });
    return null;
  }
}

interface CheffityAutoSyncSummary {
  /** 'skipped' = Supabase not configured (no error); 'ok'/'error' = ran. */
  status: 'skipped' | 'ok' | 'error';
  upserted: number;
  attempted: number;
  staleExpired: number;
  collisions: number;
  currentBucketForcedTodayCount: number;
  futureBucketForcedTomorrowCount: number;
  matcherWritten: number;
  /** Short human note for status/warnings ("Cheffity-Sync: upserted N …"). */
  note: string;
  error?: string;
}

/**
 * Run the SAME Supabase deals-sync + deal⇄recipe-ingredient matcher that the
 * manual `/api/offers/sync-supabase` endpoint runs, but against the CURRENT
 * in-memory snapshot. Called automatically after a successful scan/import
 * commit so Cheffity never lags behind a fresh snapshot.
 *
 * Fail-soft by contract: it NEVER throws. A missing Supabase config returns a
 * clean `skipped`; any sync/matcher error is caught, recorded in
 * `lastSupabaseSyncState`, surfaced as a snapshot warning, and returned in the
 * summary — the caller's scan/import stays successful either way.
 */
async function runCheffitySyncForCurrentSnapshot(
  trigger: string,
  options?: { scanType?: string },
): Promise<CheffityAutoSyncSummary> {
  const empty = {
    upserted: 0,
    attempted: 0,
    staleExpired: 0,
    collisions: 0,
    currentBucketForcedTodayCount: 0,
    futureBucketForcedTomorrowCount: 0,
    matcherWritten: 0,
  };
  if (!isSupabaseSyncConfigured()) {
    appendBackendDebugLog('info', 'offers.cheffityAutoSync.skipped', {
      trigger,
      reason: 'supabase_not_configured',
    });
    return { status: 'skipped', ...empty, note: 'Cheffity-Sync übersprungen (Supabase nicht konfiguriert).' };
  }
  const scanType = options?.scanType ?? 'auto_sync';
  const { combinedOffers, nextWeekOfferIds } = buildCheffitySyncInput(snapshot);
  appendBackendDebugLog('info', 'offers.cheffityAutoSync.start', {
    trigger,
    offersCount: snapshot.offers.length,
    nextWeekCount: snapshot.nextWeekOffers.length,
  });
  try {
    const syncResult = await syncDealsToSupabase(combinedOffers, snapshot.offerScopes, {
      nextWeekOfferIds,
      disabledStores: parseDisabledStores(appConfig.offersDisabledStores),
    });
    appendBackendDebugLog('info', 'offers.cheffityAutoSync.synced', {
      trigger,
      attempted: syncResult.attempted,
      upserted: syncResult.upserted,
      skipped: syncResult.skipped,
      staleExpired: syncResult.staleExpired,
      staleByStore: syncResult.staleByStore,
      staleExpireErrors: syncResult.staleExpireErrors.length,
      collisions: syncResult.collisions,
      currentBucketForcedTodayCount: syncResult.currentBucketForcedTodayCount,
      futureBucketForcedTomorrowCount: syncResult.futureBucketForcedTomorrowCount,
      errorsCount: syncResult.errors.length,
      durationMs: syncResult.durationMs,
    });
    // Same snapshot → offer_history. Best-effort: a history error never flips the
    // auto-sync to failed.
    try {
      const historyResult = await writeOfferHistory(
        combinedOffers as Array<typeof combinedOffers[number] & Record<string, unknown>>,
        { scanType },
      );
      appendBackendDebugLog('info', 'offers.cheffityAutoSync.history', {
        trigger,
        snapshotId: historyResult.snapshotId,
        scanRunId: historyResult.scanRunId,
        written: historyResult.written,
        expired: historyResult.expired,
        errors: historyResult.errors.length,
      });
    } catch (historyError) {
      appendBackendDebugLog('error', 'offers.cheffityAutoSync.history.failed', {
        trigger,
        error: historyError instanceof Error ? historyError.message : String(historyError),
      });
    }
    lastSupabaseSyncState.at = new Date().toISOString();
    lastSupabaseSyncState.status = syncResult.errors.length === 0 ? 'ok' : 'error';
    lastSupabaseSyncState.upserted = syncResult.upserted;
    lastSupabaseSyncState.errors = syncResult.errors.length;
    // Rebuild deal⇄recipe-ingredient matches off the freshly-synced deals.
    const matchResult = await runDealRecipeMatchSafe(trigger);
    const matcherWritten = matchResult?.writtenMatches ?? 0;
    const ok = syncResult.errors.length === 0;
    const note = ok
      ? `Cheffity-Sync: upserted ${syncResult.upserted}, Matcher ${matcherWritten} Matches.`
      : `Cheffity-Sync: ${syncResult.errors.length} Fehler (${syncResult.upserted}/${syncResult.attempted} synchronisiert), Matcher ${matcherWritten}.`;
    if (!ok) {
      // Surface partial-failure honestly without flipping the scan to failed.
      snapshot.warnings = sanitizeWarnings([...snapshot.warnings, note]);
      await saveSnapshot().catch(() => undefined);
    }
    return {
      status: ok ? 'ok' : 'error',
      upserted: syncResult.upserted,
      attempted: syncResult.attempted,
      staleExpired: syncResult.staleExpired,
      collisions: syncResult.collisions,
      currentBucketForcedTodayCount: syncResult.currentBucketForcedTodayCount,
      futureBucketForcedTomorrowCount: syncResult.futureBucketForcedTomorrowCount,
      matcherWritten,
      note,
      error: ok ? undefined : `${syncResult.errors.length} Sync-Fehler`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lastSupabaseSyncState.at = new Date().toISOString();
    lastSupabaseSyncState.status = 'error';
    lastSupabaseSyncState.errors = (lastSupabaseSyncState.errors ?? 0) + 1;
    const note = `Cheffity-Sync fehlgeschlagen: ${message}`;
    appendBackendDebugLog('error', 'offers.cheffityAutoSync.failed', { trigger, error: message });
    try {
      snapshot.warnings = sanitizeWarnings([...snapshot.warnings, note]);
      await saveSnapshot();
    } catch {
      // best-effort: surfacing the warning must not throw into the scan path.
    }
    return { status: 'error', ...empty, note, error: message };
  }
}

const oneClickAiState: {
  running: boolean;
  stage: 'idle' | 'preparing' | 'ingest' | 'enrichment' | 'rescan' | 'appStart' | 'done' | 'error';
  total: number;
  processed: number;
  message: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  removedCount: number;
  removedFilteredCount: number;
} = {
  running: false,
  stage: 'idle',
  total: 0,
  processed: 0,
  message: 'idle',
  startedAt: null,
  finishedAt: null,
  lastError: null,
  removedCount: 0,
  removedFilteredCount: 0,
};

let oneClickAiBackgroundTask: Promise<void> | null = null;
// Abort handle for the One-Click-KI pipeline child (set once the category
// pipeline starts), so /cancel can terminate it mid-run.
let oneClickAiAbortController: AbortController | null = null;

function startOneClickAiState(
  removedCount: number,
  removedFilteredCount: number,
): void {
  oneClickAiState.running = true;
  oneClickAiState.stage = 'preparing';
  oneClickAiState.total = 0;
  oneClickAiState.processed = 0;
  oneClickAiState.message = 'One-Click-KI gestartet.';
  oneClickAiState.startedAt = new Date().toISOString();
  oneClickAiState.finishedAt = null;
  oneClickAiState.lastError = null;
  oneClickAiState.removedCount = removedCount;
  oneClickAiState.removedFilteredCount = removedFilteredCount;
}

function updateOneClickAiStage(
  stage: 'preparing' | 'ingest' | 'enrichment' | 'rescan' | 'appStart' | 'done' | 'error',
  message: string,
  processed = oneClickAiState.processed,
  total = oneClickAiState.total,
): void {
  oneClickAiState.stage = stage;
  oneClickAiState.message = message;
  oneClickAiState.processed = processed;
  oneClickAiState.total = total;
}

function finishOneClickAiSuccess(message: string): void {
  oneClickAiState.running = false;
  oneClickAiState.stage = 'done';
  oneClickAiState.message = message;
  oneClickAiState.finishedAt = new Date().toISOString();
  oneClickAiState.lastError = null;
}

function finishOneClickAiError(message: string): void {
  oneClickAiState.running = false;
  oneClickAiState.stage = 'error';
  oneClickAiState.message = `Fehler: ${message}`;
  oneClickAiState.finishedAt = new Date().toISOString();
  oneClickAiState.lastError = message;
}

function updateOneClickAiIngestProgress(
  message: string,
  total?: number,
  completed?: number,
): void {
  if (total && completed) {
    updateOneClickAiStage(
      'ingest',
      `One-Click-KI Ingest: ${message} (${completed}/${total})`,
      completed,
      total,
    );
    return;
  }
  updateOneClickAiStage(
    'ingest',
    `One-Click-KI Ingest: ${message}`,
    oneClickAiState.processed,
    oneClickAiState.total,
  );
}

function updateOneClickAiEnrichmentProgress(
  progress: OffersCategorizerProgress,
): void {
  updateOneClickAiStage(
    'enrichment',
    `One-Click-KI Kategorie: ${progress.processed}/${progress.total}`,
    progress.processed,
    progress.total,
  );
}

function updateOneClickAiRescanProgress(
  progress: OffersCategorizerProgress,
): void {
  updateAiRescanStateProgress(progress);
  updateOneClickAiStage(
    'rescan',
    `One-Click-KI Lebensmittel: ${progress.processed}/${progress.total}`,
    progress.processed,
    progress.total,
  );
}

function startAiRescanState(
  total: number,
  message: string,
  scope: { scopeType: 'all' | 'stores'; storeChains: string[] } = {
    scopeType: 'all',
    storeChains: [],
  },
  mode: 'all' | 'missing_or_uncertain' = 'all',
  preflightWarning: string | null = null,
): void {
  aiRescanState.running = true;
  aiRescanState.total = total;
  aiRescanState.processed = 0;
  aiRescanState.message = message;
  aiRescanState.startedAt = new Date().toISOString();
  aiRescanState.finishedAt = null;
  aiRescanState.lastError = null;
  aiRescanState.scannedCount = 0;
  aiRescanState.aiClassifiedCount = 0;
  aiRescanState.fallbackCount = 0;
  aiRescanState.scopeType = scope.scopeType;
  aiRescanState.storeChains = scope.storeChains;
  aiRescanState.mode = mode;
  aiRescanState.selective = null;
  aiRescanState.durationMs = null;
  aiRescanState.preflightWarning = preflightWarning;
}

function updateAiRescanStateProgress(progress: OffersCategorizerProgress): void {
  aiRescanState.total = progress.total;
  aiRescanState.processed = progress.processed;
  aiRescanState.message = `${progress.message} (${progress.processed}/${progress.total})`;
}

function finishAiRescanStateSuccess(
  scannedCount: number,
  aiClassifiedCount: number,
  fallbackCount: number,
  message: string,
  selective: SelectiveRescanStats | null = null,
): void {
  const finishedAt = new Date().toISOString();
  const durationMs = aiRescanState.startedAt
    ? Math.max(0, Date.parse(finishedAt) - Date.parse(aiRescanState.startedAt))
    : null;
  aiRescanState.running = false;
  aiRescanState.total = scannedCount;
  aiRescanState.processed = scannedCount;
  aiRescanState.message = message;
  aiRescanState.finishedAt = finishedAt;
  aiRescanState.lastError = null;
  aiRescanState.scannedCount = scannedCount;
  aiRescanState.aiClassifiedCount = aiClassifiedCount;
  aiRescanState.fallbackCount = fallbackCount;
  aiRescanState.selective = selective;
  aiRescanState.durationMs = durationMs;

  // Remember the last run of each mode for the admin-v2 comparison KPIs.
  if (aiRescanState.mode === 'missing_or_uncertain' && selective) {
    lastAiRescanByMode.missing_or_uncertain = {
      at: finishedAt,
      durationMs: durationMs ?? 0,
      sentToModel: selective.sentToModel,
      classifiedByAi: selective.classifiedByAi,
      reusedProductAnalysis: selective.reusedProductAnalysis,
      skipped: selective.skippedUpToDate + selective.skippedLocked,
    };
  } else if (aiRescanState.mode === 'all') {
    lastAiRescanByMode.all = {
      at: finishedAt,
      durationMs: durationMs ?? 0,
      scannedCount,
      aiClassifiedCount,
    };
  }
}

function finishAiRescanStateError(message: string): void {
  aiRescanState.running = false;
  aiRescanState.finishedAt = new Date().toISOString();
  aiRescanState.lastError = message;
  aiRescanState.message = `Fehler: ${message}`;
}

// Distinct from an error: a user-requested cancel. running=false, a clear
// message, and lastError set so the UI/tests can show "abgebrochen" without it
// looking like an Ollama crash.
function finishAiRescanStateCancelled(message = 'KI-Lauf vom Nutzer abgebrochen.'): void {
  aiRescanState.running = false;
  aiRescanState.finishedAt = new Date().toISOString();
  aiRescanState.lastError = message;
  aiRescanState.message = message;
}

// Shared KI-scan preflight: ensures Ollama is up, the scan model is installed,
// and a tiny JSON prompt succeeds BEFORE any snapshot work begins. Returns a
// 503-style failure the endpoints can return verbatim; never touches the
// snapshot. Skipped when tryOllama is false (rule-based scan needs no Ollama).
async function ensureScanPreflight(
  tryOllama: boolean,
): Promise<
  | { ok: true; source?: 'managed' | 'external'; warning?: string | null }
  | { ok: false; status: number; error: string; reason?: string }
> {
  if (!tryOllama) return { ok: true };

  // Prefer whatever Ollama already runs (external or managed) — never spawn a
  // redundant `ollama serve` against a busy port.
  const avail = await ensureOllamaAvailable();
  if (!avail.ok) {
    return { ok: false, status: 503, error: avail.error, reason: 'unreachable' };
  }

  const result = await runOllamaPreflight({
    host: resolveOllamaHost(),
    model: resolveOllamaModel(),
    // A loaded model answers fast; cap the smoke so it can never become a 20 s+
    // blocker, and soft-pass (warning) if it times out while GPU-resident.
    smokeTimeoutMs: Math.min(Math.max(appConfig.ollamaTimeoutMs, 8000), 30000),
    loadedSmokeTimeoutMs: 6000,
  });
  if (result.ok) {
    appendBackendDebugLog('info', 'offers.scanPreflight.ok', {
      model: result.model,
      smokeMs: result.smokeMs,
      smokeSkipped: result.smokeSkipped ?? false,
      installedCount: result.installedModels.length,
      source: avail.source,
      warning: result.warning ?? null,
      psLoaded: result.ps?.loaded ?? null,
      diagnostic: result.diagnostic ?? null,
      // Log-safe smoke diagnostics (lengths + protocol fields, never model text).
      smoke: result.smoke ?? null,
    });
    return { ok: true, source: avail.source, warning: result.warning ?? null };
  }

  appendBackendDebugLog('warn', 'offers.scanPreflight.failed', {
    stage: result.stage,
    reason: result.reason,
    diagnostic: result.diagnostic ?? null,
    message: result.message,
    source: avail.source,
    smoke: result.smoke ?? null,
  });
  return { ok: false, status: 503, error: result.message, reason: result.reason };
}

// After the smoke-test has loaded the model, figure out whether that model is
// actually sitting on the GPU. Two best-effort signals (either may be missing):
//   * the captured Ollama load log → exact "X/Y layers" counts (only when we
//     started `ollama serve`), and
//   * /api/ps → size / size_vram bytes (works for an externally-started Ollama).
// Returns null when neither signal says the model is loaded — the GPU preflight
// then falls back to the plain free-VRAM threshold.
async function resolveLoadedModelGpuStatus(
  model: string,
): Promise<LoadedModelGpuStatus | null> {
  const logs = getManagedProcessStatus().ollama.recentLogs;
  const layers = parseOllamaOffloadLayers(logs);
  const ps = await getOllamaPsStatus({ host: resolveOllamaHost(), model }).catch(() => null);

  if (!layers && !(ps && ps.loaded)) return null;

  return {
    loaded: true,
    gpuLayers: layers?.gpuLayers,
    totalLayers: layers?.totalLayers,
    sizeVramBytes: ps && ps.loaded ? ps.sizeVramBytes : undefined,
    sizeBytes: ps && ps.loaded ? ps.sizeBytes : undefined,
  };
}

async function runNationalAndLocalIngest(options: {
  locationFilter: LocationFilter;
  tryOllama: boolean;
  // Store chains to skip while scraping (e.g. REWE/nahkauf for the weekly
  // auto-scan). The official national connector skips them entirely.
  excludeStoreChains?: readonly string[];
  // Abbruchsignal des laufenden Scans (Cancel/Pause). Wird an die Connectoren
  // durchgereicht, damit ein Abbruch einen hängenden Per-Store-Fetch sauber stoppt
  // (statt still im Hintergrund weiterzulaufen).
  signal?: AbortSignal;
  onProgress?: (
    scope: OfferSourceScope,
    message: string,
    total?: number,
    completed?: number,
  ) => void;
}): Promise<{
  offers: Offer[];
  offerScopes: OfferScopeMap;
  warnings: string[];
  subSourceDiagnostics: SubSourceDiagnostic[];
  sourceCounts: {
    national: number;
    local: number;
    combined: number;
  };
}> {
  const nationalConnectors = [
    new OfficialSupermarketSourceConnector({
      excludeStoreChains: options.excludeStoreChains,
    }),
  ];
  const localConnectors = [new LocalMarketSourceConnector()];

  const nationalResult = await runOffersIngestPipeline(
    {
      locationFilter: options.locationFilter,
      tryOllama: options.tryOllama,
      signal: options.signal,
      onProgress: (message, total, completed) => {
        options.onProgress?.('national', message, total, completed);
      },
    },
    nationalConnectors,
  );

  const localResult = await runOffersIngestPipeline(
    {
      locationFilter: options.locationFilter,
      tryOllama: options.tryOllama,
      signal: options.signal,
      onProgress: (message, total, completed) => {
        options.onProgress?.('local', message, total, completed);
      },
    },
    localConnectors,
  );

  const offerScopes = buildOfferScopesFromScopedOffers([
    { scope: 'national', offers: nationalResult.offers },
    { scope: 'local', offers: localResult.offers },
  ]);
  const offers = dedupeOffersById([...nationalResult.offers, ...localResult.offers]);

  return {
    offers,
    offerScopes,
    warnings: [...nationalResult.warnings, ...localResult.warnings],
    subSourceDiagnostics: [
      ...nationalResult.subSourceDiagnostics,
      ...localResult.subSourceDiagnostics,
    ],
    sourceCounts: {
      national: nationalResult.offers.length,
      local: localResult.offers.length,
      combined: offers.length,
    },
  };
}

/**
 * Incremental ("missing_or_uncertain") categorization: instead of sending every
 * offer to the model, only offers whose analysis is missing/uncertain/stale go
 * to Ollama, identical products are analysed once, and good existing analyses are
 * reused. Produces the SAME `OffersCategorizerResult` shape as the classic full
 * run, so the snapshot-apply path downstream is identical.
 *
 * Pipeline:
 *   1. selectAiCandidates → up-to-date / locked / candidates.
 *   2. Reuse: candidates whose product already has a good analysis (in up-to-date
 *      /locked donors) are filled without the model.
 *   3. Dedupe the remaining candidates by product key → one representative each;
 *      run the Python/Ollama pipeline on representatives only.
 *   4. Propagate each representative's fresh analysis to its followers.
 *   5. Combine everything and split into food/non-food for the apply step.
 *
 * Locked/manual offers are never sent to the model and never overwritten.
 */
async function computeSelectiveCategorization(
  sourceOffers: Offer[],
  options: {
    tryOllama: boolean;
    signal: AbortSignal;
    onProgress: (progress: OffersCategorizerProgress) => void;
    model: string;
  },
): Promise<{ result: OffersCategorizerResult; selective: SelectiveRescanStats }> {
  const now = new Date().toISOString();
  const stamp = { now, model: options.model, version: PRODUCT_INTELLIGENCE_VERSION };

  // 1) Partition the universe.
  const selection = selectAiCandidates(sourceOffers);
  const donors = [...selection.upToDate, ...selection.locked];

  // 2) Reuse existing good analyses for candidates of the same product.
  const existingIndex = buildProductAnalysisIndex(donors);
  const phaseA = reuseProductAnalysis(selection.candidates, existingIndex, stamp);

  // 3) Analyse each remaining product once (representatives → model).
  const { representatives, followers } = dedupeByProductKey(phaseA.stillNeedAi);

  // Surface the plan immediately so the admin status reflects the fast path.
  // NOTE: "sentToModel" is *attempted*, not yet classified — classifiedByAi/
  // fallbackOnly are filled in after the model returns, so the UI never claims
  // a KI success before there is one.
  aiRescanState.total = representatives.length;
  aiRescanState.processed = 0;
  aiRescanState.selective = {
    candidatesSelected: selection.candidates.length,
    sentToModel: representatives.length,
    classifiedByAi: 0,
    fallbackOnly: 0,
    reusedProductAnalysis: phaseA.reused.length,
    skippedUpToDate: selection.upToDate.length,
    skippedLocked: selection.locked.length,
    uncertainRemaining: 0,
    timedOutItems: 0,
    reviewNeededFromTimeout: 0,
    conflictRejected: 0,
    lastTimedOutOfferName: null,
    lastOllamaError: null,
  };
  aiRescanState.message =
    `Inkrementell: ${selection.candidates.length} Kandidaten · ${representatives.length} an Modell gesendet · ` +
    `${phaseA.reused.length} aus Produkt-Cache · ${selection.upToDate.length} aktuell.`;

  let pythonResult: OffersCategorizerResult | null = null;
  let pythonFood: Offer[] = [];
  let pythonFiltered: Offer[] = [];
  if (representatives.length > 0) {
    pythonResult = await runOffersCategorizerPipeline(representatives, {
      tryOllama: options.tryOllama,
      mode: appConfig.offerWeekMode,
      engine: 'aichef_offers',
      onProgress: options.onProgress,
      signal: options.signal,
      // qwen3:14b needs more per-item time than the central default; a single
      // slow product now times out gracefully (reviewNeeded) instead of aborting.
      ollamaTimeoutMs: appConfig.aiRescanOllamaTimeoutMs,
      ollamaRetries: appConfig.aiRescanOllamaRetries,
      model: options.model,
    });
    // Stamp the source HONESTLY per offer: source:"ai" only for real model hits,
    // otherwise source:"rule" — fallback offers are never mislabelled as KI.
    pythonFood = pythonResult.offers.map((offer) => stampAnalysisMeta(offer, stamp));
    pythonFiltered = pythonResult.filteredOffers.map((offer) => stampAnalysisMeta(offer, stamp));
  }

  // 4) Propagate freshly-analysed products to their followers. Followers share a
  //    representative's exact product key, so we map directly by key — copying
  //    even an uncertain result (incl. its reviewNeeded flag) keeps siblings
  //    consistent and honestly flagged, rather than leaving them un-analysed.
  const representativeIndex = new Map<string, Offer>();
  for (const rep of [...pythonFood, ...pythonFiltered]) {
    const key = productKeyForOffer(rep);
    if (!representativeIndex.has(key)) representativeIndex.set(key, rep);
  }
  const phaseB = reuseProductAnalysis(followers, representativeIndex, stamp);

  // 5) Combine the whole universe (never drop an offer) and split for the apply.
  const combined: Offer[] = [
    ...selection.upToDate,
    ...selection.locked,
    ...phaseA.reused,
    ...pythonFood,
    ...pythonFiltered,
    ...phaseB.reused,
    ...phaseB.stillNeedAi, // safety: no donor materialised — keep as-is, never lose
  ];
  const split = splitFoodAndNonFood(combined);

  const reusedTotal = phaseA.reused.length + phaseB.reused.length;
  const classifiedByAi = pythonResult ? pythonResult.aiClassifiedCount : 0;
  const fallbackOnly = pythonResult ? pythonResult.fallbackCount : 0;
  const warnings = pythonResult ? [...pythonResult.warnings] : [];
  warnings.push(
    `Inkrementeller KI-Scan: ${selection.candidates.length} Kandidaten · ` +
      `${representatives.length} an Modell gesendet (${classifiedByAi} per KI klassifiziert, ` +
      `${fallbackOnly} nur Fallback) · ${reusedTotal} aus Produkt-Cache wiederverwendet · ` +
      `${selection.upToDate.length} bereits aktuell · ${selection.locked.length} gesperrt (unverändert).`,
  );

  const uncertainRemaining = countUncertain(combined);
  const timedOutItems = pythonResult ? pythonResult.timedOutCount : 0;
  if (timedOutItems > 0) {
    warnings.push(
      `${timedOutItems} Produkt(e) per KI-Timeout übersprungen und als Review markiert` +
        `${pythonResult?.lastTimedOutOfferName ? ` (zuletzt: ${pythonResult.lastTimedOutOfferName})` : ''}.`,
    );
  }
  const selective: SelectiveRescanStats = {
    candidatesSelected: selection.candidates.length,
    sentToModel: representatives.length,
    classifiedByAi,
    fallbackOnly,
    reusedProductAnalysis: reusedTotal,
    skippedUpToDate: selection.upToDate.length,
    skippedLocked: selection.locked.length,
    uncertainRemaining,
    timedOutItems,
    reviewNeededFromTimeout: pythonResult ? pythonResult.reviewNeededFromTimeout : 0,
    conflictRejected: pythonResult ? pythonResult.conflictRejected : 0,
    lastTimedOutOfferName: pythonResult ? pythonResult.lastTimedOutOfferName : null,
    lastOllamaError: pythonResult ? pythonResult.lastOllamaError : null,
  };

  return {
    result: {
      offers: split.food,
      filteredOffers: split.nonFood,
      warnings,
      scannedCount: pythonResult ? pythonResult.scannedCount : 0,
      aiClassifiedCount: pythonResult ? pythonResult.aiClassifiedCount : 0,
      fallbackCount: pythonResult ? pythonResult.fallbackCount : 0,
      reviewNeededCount: pythonResult ? pythonResult.reviewNeededCount : 0,
      timedOutCount: timedOutItems,
      reviewNeededFromTimeout: pythonResult ? pythonResult.reviewNeededFromTimeout : 0,
      conflictRejected: pythonResult ? pythonResult.conflictRejected : 0,
      lastTimedOutOfferName: pythonResult ? pythonResult.lastTimedOutOfferName : null,
      lastOllamaError: pythonResult ? pythonResult.lastOllamaError : null,
    },
    selective,
  };
}

interface AiRescanPlan {
  mode: 'all' | 'missing_or_uncertain';
  /** Offers in scope (the candidate universe). */
  totalOffers: number;
  /** Offers selected as missing/uncertain/stale (all mode: every non-locked). */
  candidatesSelected: number;
  /** Candidates that could be filled from a sibling's analysis (no model). */
  reusableFromCache: number;
  /** Distinct products that would actually be sent to the model. */
  sentToModel: number;
  /** Already good + current (skipped). */
  skippedUpToDate: number;
  /** Editorially locked (skipped, never overwritten). */
  skippedLocked: number;
}

/**
 * Plan a run WITHOUT touching Ollama or the snapshot — used by the start
 * endpoints to size the all-stores guard against the offers that would really
 * hit the model, and by dryRun to return counts only. Pure + fast.
 */
function planAiRescan(sourceOffers: Offer[], mode: 'all' | 'missing_or_uncertain'): AiRescanPlan {
  const totalOffers = sourceOffers.length;
  if (mode === 'all') {
    return {
      mode,
      totalOffers,
      candidatesSelected: totalOffers,
      reusableFromCache: 0,
      sentToModel: totalOffers,
      skippedUpToDate: 0,
      skippedLocked: 0,
    };
  }
  const plan = planIncrementalScan(sourceOffers);
  return { mode, totalOffers, ...plan };
}

async function runAiFoodRescanFlow(
  sourceOffers: Offer[],
  tryOllama: boolean,
  // When set, only `sourceOffers` (the selected stores) are re-categorized and
  // merged back; `retained` (all other stores) is preserved untouched.
  scope?: { storeChains: string[]; retained: SnapshotBuckets },
  // "all" (default) = classic full re-scan; "missing_or_uncertain" = incremental.
  mode: 'all' | 'missing_or_uncertain' = 'all',
  // Preflight heads-up (e.g. smoke soft-pass) surfaced in the status.
  preflightWarning: string | null = null,
  // Ollama model override (e.g. qwen3:14b vs llama3.1:8b for comparison).
  model: string = resolveOllamaModel(),
): Promise<{
  scannedCount: number;
  aiClassifiedCount: number;
  fallbackCount: number;
}> {
  const scopeInfo = scope
    ? { scopeType: 'stores' as const, storeChains: scope.storeChains }
    : { scopeType: 'all' as const, storeChains: [] };
  startAiRescanState(
    sourceOffers.length,
    mode === 'missing_or_uncertain'
      ? `Inkrementeller KI-Scan gestartet (${sourceOffers.length} Angebote werden geprüft)…`
      : `KI-Rescan gestartet (0/${sourceOffers.length}).`,
    scopeInfo,
    mode,
    preflightWarning,
  );

  if (tryOllama && sourceOffers.length > 0) {
    // Reuse whatever Ollama already runs; only start a managed process if nothing
    // is reachable (avoids a redundant `ollama serve` against a busy port).
    const avail = await ensureOllamaAvailable();
    if (!avail.ok) {
      throw new Error(avail.error);
    }
    const ollamaState = getManagedProcessStatus().ollama;
    appendBackendDebugLog('info', 'offers.rescanFoodAi.ollamaStartRequested', {
      running: ollamaState.running,
      pid: ollamaState.pid,
      source: avail.source,
      host: resolveOllamaHost(),
    });
  }

  const controller = new AbortController();
  aiRescanAbortController = controller;

  try {
    // Engine `aichef_offers` (statt des leichteren `offers_categorizer`): es ist
    // derselbe Pfad, den One-Click bereits nutzt, und der EINZIGE, der echte
    // Produktinfos anreichert (Nutrition via OpenFoodFacts/BLS, Allergene,
    // Diät/Halal). WICHTIG: Es läuft NUR auf dem aktuellen Snapshot
    // (`sourceOffers`) — kein neuer Ingest/Scrape. Kategorien werden weiterhin
    // verbessert (canonicalCategory → einfache Kategorie in der Bridge).
    // mode "all": classic full re-scan (every offer → model). mode
    // "missing_or_uncertain": incremental — only missing/uncertain/stale offers
    // hit the model, identical products are analysed once, good analyses reused.
    // Both produce the SAME result shape so everything below is unchanged.
    let selectiveStats: SelectiveRescanStats | null = null;
    let categorization: OffersCategorizerResult;
    if (mode === 'missing_or_uncertain') {
      const selective = await computeSelectiveCategorization(sourceOffers, {
        tryOllama,
        signal: controller.signal,
        onProgress: updateAiRescanStateProgress,
        model,
      });
      categorization = selective.result;
      selectiveStats = selective.selective;
    } else {
      categorization = await runOffersCategorizerPipeline(sourceOffers, {
        tryOllama,
        mode: appConfig.offerWeekMode,
        engine: 'aichef_offers',
        onProgress: updateAiRescanStateProgress,
        signal: controller.signal,
        // Same qwen3-friendly per-item timeout + retry budget as the incremental
        // path, so a slow product times out gracefully instead of aborting.
        ollamaTimeoutMs: appConfig.aiRescanOllamaTimeoutMs,
        ollamaRetries: appConfig.aiRescanOllamaRetries,
        model,
      });
    }

    // Data integrity: a KI run (tryOllama) that scanned offers but produced ZERO
    // KI classifications means Ollama did nothing — the result is a pure
    // rule-based fallback that must NOT overwrite the existing good snapshot.
    // Throw before any snapshot mutation so the catch records it as a failure.
    // (In incremental mode scannedCount is 0 when everything was reused/current,
    // which is NOT a failure — the guard already ignores scannedCount === 0.)
    if (
      isZeroAiClassificationFailure({
        tryOllama,
        scannedCount: categorization.scannedCount,
        aiClassifiedCount: categorization.aiClassifiedCount,
      })
    ) {
      throw new Error(
        `KI-Lauf abgebrochen: 0 KI-Klassifizierungen bei aktivierter KI ` +
          `(${categorization.scannedCount} gescannt, alles Regel-Fallback). ` +
          `Snapshot unveraendert — bitte Ollama pruefen und erneut starten.`,
      );
    }

    // Quality gate: a run that sent items to the model must classify a minimum
    // FRACTION of them for real (not rule-fallback). Below the threshold the
    // result is mostly fallback and must NOT overwrite the snapshot — this is
    // exactly the "3/247 valid" case. Skipped when nothing was sent to the model
    // (scannedCount === 0 → everything reused/up-to-date, a valid no-op).
    if (tryOllama && categorization.scannedCount > 0) {
      const ratio = categorization.aiClassifiedCount / categorization.scannedCount;
      const minRatio = appConfig.aiRescanMinAiSuccessRatio;
      if (minRatio > 0 && ratio < minRatio) {
        const pct = Math.round(ratio * 100);
        const minPct = Math.round(minRatio * 100);
        throw new Error(
          `KI-Qualität zu niedrig: ${categorization.aiClassifiedCount}/${categorization.scannedCount} ` +
            `valide (${pct}%, Schwelle ${minPct}%). Snapshot nicht geschrieben — ` +
            `Ollama/Modell prüfen (Structured Output) und erneut starten.`,
        );
      }
    }

    // Apply step. "all" replaces the snapshot via the shared helper; a store
    // scope re-categorizes only the selected offers, then merges them back with
    // the retained (untouched) offers so unselected stores never disappear.
    let strictRemovedCount: number;
    let strictRemovedExamples: string[];
    let droppedCount: number;

    if (scope) {
      const strict = filterOffersStrictFood(categorization.offers);
      const split = splitOffersByWeek(strict.offers);
      const recategorized: SnapshotBuckets = {
        current: split.current,
        next: split.next,
        // Selected non-food / strict-removed offers go (back) to filtered.
        filtered: dedupeOffersById([
          ...categorization.filteredOffers,
          ...strict.removedOffers,
        ]),
      };
      const merged = mergeScopedRescan(scope.retained, recategorized);
      snapshot.offers = merged.current;
      snapshot.nextWeekOffers = merged.next;
      snapshot.filteredOffers = merged.filtered;
      strictRemovedCount = strict.removedCount;
      strictRemovedExamples = strict.removedExamples;
      droppedCount = split.other.length;
    } else {
      const weekSplit = applyCategorizedOffersToSnapshot(categorization);
      strictRemovedCount = weekSplit.strictRemovedCount;
      strictRemovedExamples = weekSplit.strictRemovedExamples;
      droppedCount = weekSplit.droppedCount;
    }

    snapshot.updatedAt = new Date().toISOString();
    const scopeWarningSuffix = scope
      ? ` (Scope: ${scope.storeChains.join(', ') || 'Stores'})`
      : '';
    const warnings = sanitizeWarnings([
      ...categorization.warnings,
      `KI-Rescan abgeschlossen${scopeWarningSuffix}: ${snapshot.offers.length} Live (diese Woche), ${snapshot.nextWeekOffers.length} Naechste-Woche, ${snapshot.filteredOffers.length} Filtered.`,
    ]);
    if (categorization.reviewNeededCount > 0) {
      warnings.push(
        `Hinweis: ${categorization.reviewNeededCount} Angebot(e) brauchen Review (niedrige KI-Sicherheit).`,
      );
    }
    if (strictRemovedCount > 0) {
      warnings.push(
        `Strenger Lebensmittel-Filter: ${strictRemovedCount} Nicht-Lebensmittel entfernt. Beispiele: ${strictRemovedExamples.join(', ')}`,
      );
    }
    if (droppedCount > 0) {
      warnings.push(
        `Hinweis: ${droppedCount} Angebot(e) wurden verworfen (weder diese noch naechste Woche).`,
      );
    }
    snapshot.warnings = warnings;
    await saveSnapshot();

    finishAiRescanStateSuccess(
      categorization.scannedCount,
      categorization.aiClassifiedCount,
      categorization.fallbackCount,
      mode === 'missing_or_uncertain' && selectiveStats
        ? `Inkrementeller KI-Scan fertig: ${selectiveStats.sentToModel} an Modell gesendet ` +
            `(${selectiveStats.classifiedByAi} per KI, ${selectiveStats.fallbackOnly} Fallback) · ` +
            `${selectiveStats.reusedProductAnalysis} aus Produkt-Cache · ` +
            `${selectiveStats.skippedUpToDate} aktuell · ${selectiveStats.skippedLocked} gesperrt.`
        : `KI-Rescan abgeschlossen (${categorization.scannedCount}/${categorization.scannedCount}).`,
      selectiveStats,
    );

    return {
      scannedCount: categorization.scannedCount,
      aiClassifiedCount: categorization.aiClassifiedCount,
      fallbackCount: categorization.fallbackCount,
    };
  } catch (error) {
    if (error instanceof PipelineCancelledError) {
      // User cancel: snapshot was never touched (we throw before any apply).
      finishAiRescanStateCancelled('KI-Lauf vom Nutzer abgebrochen.');
      appendBackendDebugLog('info', 'offers.rescanFoodAi.cancelled', {
        scopeType: scope ? 'stores' : 'all',
      });
      throw error;
    }
    const message =
      error instanceof Error ? error.message : 'Unbekannter KI-Rescan-Fehler';
    finishAiRescanStateError(message);
    throw error;
  } finally {
    aiRescanAbortController = null;
  }
}

/**
 * Resolve the source offers + optional store scope for a KI-Rescan request.
 * - No / empty storeChains → whole snapshot (old behaviour, scope undefined).
 * - storeChains set → only matching offers from all buckets; the rest is
 *   captured in `scope.retained` so the flow can merge them back untouched.
 * Returns an error when the chosen stores have zero offers.
 */
function prepareAiRescanScope(rawChains?: string[]):
  | { ok: true; sourceOffers: Offer[]; scope?: { storeChains: string[]; retained: SnapshotBuckets } }
  | { ok: false; error: string } {
  const storeChains = normalizeStoreChains(rawChains);
  if (storeChains.length === 0) {
    return {
      ok: true,
      sourceOffers: dedupeOffersById([
        ...snapshot.offers,
        ...snapshot.nextWeekOffers,
        ...snapshot.filteredOffers,
      ]),
    };
  }

  const buckets: SnapshotBuckets = {
    current: snapshot.offers,
    next: snapshot.nextWeekOffers,
    filtered: snapshot.filteredOffers,
  };
  const partition = partitionOffersForScope(buckets, storeChains);
  if (partition.selected.length === 0) {
    return {
      ok: false,
      error: `Keine Angebote fuer die gewaehlten Stores gefunden (${storeChains.join(', ')}).`,
    };
  }
  return {
    ok: true,
    sourceOffers: partition.selected,
    scope: { storeChains, retained: partition.retained },
  };
}

async function runOneClickAiLiveFlow(): Promise<void> {
  const existingCount = snapshot.offers.length + snapshot.nextWeekOffers.length;
  const existingNextWeekCount = snapshot.nextWeekOffers.length;
  const existingFilteredCount = snapshot.filteredOffers.length;

  appendBackendDebugLog('info', 'offers.oneClickAi.startedWithExistingSnapshot', {
    existingCount,
    existingNextWeekCount,
    existingFilteredCount,
    updatedAt: snapshot.updatedAt,
  });

  startOneClickAiState(existingCount, existingFilteredCount);

  ingestState.running = true;
  ingestState.startedAt = new Date().toISOString();
  ingestState.finishedAt = null;
  ingestState.lastError = null;
  ingestState.message = 'One-Click-KI: Ermittlung gestartet.';

  updateOneClickAiStage('preparing', 'One-Click-KI: Ollama wird vorbereitet...');

  try {
    const ollamaState = startManagedProcess('ollama');
    appendBackendDebugLog('info', 'offers.oneClickAi.ollamaStartRequested', {
      running: ollamaState.running,
      pid: ollamaState.pid,
      host: resolveOllamaHost(),
    });

    if (!ollamaState.running && ollamaState.lastError) {
      throw new Error(`Ollama konnte nicht gestartet werden: ${ollamaState.lastError}`);
    }

    const ollamaReady = await ensureOllamaReady(12000);
    if (!ollamaReady) {
      throw new Error(
        `Ollama startet noch oder ist nicht erreichbar unter ${resolveOllamaHost()}.`,
      );
    }

    updateOneClickAiStage(
      'ingest',
      'One-Click-KI: Nationale und lokale Angebote werden ermittelt...',
    );
    const scopedIngest = await runNationalAndLocalIngest({
      locationFilter: defaultLocationFilter,
      tryOllama: false,
      onProgress: (scope, message, total, completed) => {
        const scopeLabel = scope === 'national' ? 'National' : 'Lokal';
        updateOneClickAiIngestProgress(`${scopeLabel}: ${message}`, total, completed);
        if (total && completed) {
          ingestState.message = `One-Click-KI ${scopeLabel}: ${message} (${completed}/${total})`;
          return;
        }
        ingestState.message = `One-Click-KI ${scopeLabel}: ${message}`;
      },
    });

    appendBackendDebugLog('info', 'offers.oneClickAi.ingest.scopeCounts', {
      nationalCount: scopedIngest.sourceCounts.national,
      localCount: scopedIngest.sourceCounts.local,
      combinedCount: scopedIngest.sourceCounts.combined,
    });

    updateOneClickAiStage(
      'enrichment',
      `One-Click-KI: Kategorie-Pipeline gestartet (0/${scopedIngest.offers.length}).`,
      0,
      scopedIngest.offers.length,
    );
    ingestState.message = 'One-Click-KI: Kategorie-Pipeline...';

    startAiRescanState(
      scopedIngest.offers.length,
      `One-Click-KI: Lebensmittel-Scan gestartet (0/${scopedIngest.offers.length}).`,
    );
    updateOneClickAiStage(
      'rescan',
      `One-Click-KI: Lebensmittel-Scan gestartet (0/${scopedIngest.offers.length}).`,
      0,
      scopedIngest.offers.length,
    );

    const oneClickController = new AbortController();
    oneClickAiAbortController = oneClickController;
    const categorization = await runOffersCategorizerPipeline(scopedIngest.offers, {
      tryOllama: true,
      mode: appConfig.offerWeekMode,
      engine: 'aichef_offers',
      onProgress: (progress) => {
        updateOneClickAiEnrichmentProgress(progress);
        updateOneClickAiRescanProgress(progress);
        ingestState.message = `One-Click-KI: Kategorie-Pipeline ${progress.processed}/${progress.total}`;
      },
      signal: oneClickController.signal,
    });

    // Same data-integrity guard as the rescan flow: 0 KI classifications with
    // KI enabled is a failure, not a success — never apply it to the snapshot.
    if (
      isZeroAiClassificationFailure({
        tryOllama: true,
        scannedCount: categorization.scannedCount,
        aiClassifiedCount: categorization.aiClassifiedCount,
      })
    ) {
      throw new Error(
        `One-Click-KI abgebrochen: 0 KI-Klassifizierungen bei aktivierter KI ` +
          `(${categorization.scannedCount} gescannt, alles Regel-Fallback). ` +
          `Snapshot unveraendert — bitte Ollama pruefen.`,
      );
    }

    finishAiRescanStateSuccess(
      categorization.scannedCount,
      categorization.aiClassifiedCount,
      categorization.fallbackCount,
      `One-Click-KI: Lebensmittel-Scan fertig (${categorization.scannedCount}/${categorization.scannedCount}).`,
    );

    snapshot.offerScopes = mergeOfferScopeMaps(
      snapshot.offerScopes,
      scopedIngest.offerScopes,
    );
    const weekSplit = applyCategorizedOffersToSnapshot(categorization);
    const warnings = sanitizeWarnings([
      ...scopedIngest.warnings,
      ...categorization.warnings,
      `One-Click-KI abgeschlossen: ${weekSplit.liveCount} Live (diese Woche), ${weekSplit.nextWeekCount} Naechste-Woche, ${snapshot.filteredOffers.length} Filtered.`,
    ]);
    if (categorization.reviewNeededCount > 0) {
      warnings.push(
        `Hinweis: ${categorization.reviewNeededCount} Angebot(e) brauchen Review (niedrige KI-Sicherheit).`,
      );
    }
    if (weekSplit.strictRemovedCount > 0) {
      warnings.push(
        `Strenger Lebensmittel-Filter: ${weekSplit.strictRemovedCount} Nicht-Lebensmittel entfernt. Beispiele: ${weekSplit.strictRemovedExamples.join(', ')}`,
      );
    }
    if (weekSplit.droppedCount > 0) {
      warnings.push(
        `Hinweis: ${weekSplit.droppedCount} Angebot(e) wurden verworfen (weder diese noch naechste Woche).`,
      );
    }
    snapshot.warnings = warnings;
    snapshot.updatedAt = new Date().toISOString();
    await saveSnapshot();

    updateOneClickAiStage('appStart', 'One-Click-KI: App-Start wird ausgefuehrt...');
    const appState = startManagedProcess('app');
    if (!appState.running && appState.lastError) {
      snapshot.warnings = [
        ...snapshot.warnings,
        `App-Start fehlgeschlagen: ${appState.lastError}`,
      ];
      await saveSnapshot();
    }

    ingestState.running = false;
    ingestState.finishedAt = new Date().toISOString();
    ingestState.message = `One-Click-KI fertig: ${snapshot.offers.length} Live + ${snapshot.nextWeekOffers.length} Naechste-Woche.`;

    finishOneClickAiSuccess(
      `One-Click-KI fertig: ${snapshot.offers.length} Live, ${snapshot.nextWeekOffers.length} Naechste-Woche, ${snapshot.filteredOffers.length} Filtered.`,
    );

    appendBackendDebugLog('info', 'offers.oneClickAi.completed', {
      offersCount: snapshot.offers.length,
      nextWeekOffersCount: snapshot.nextWeekOffers.length,
      filteredOffersCount: snapshot.filteredOffers.length,
      liveScopeCounts: countOffersByScope(snapshot.offers),
      nextWeekScopeCounts: countOffersByScope(snapshot.nextWeekOffers),
      filteredScopeCounts: countOffersByScope(snapshot.filteredOffers),
      warningsCount: snapshot.warnings.length,
      aiClassifiedCount: categorization.aiClassifiedCount,
      fallbackCount: categorization.fallbackCount,
      appRunning: appState.running,
      updatedAt: snapshot.updatedAt,
    });

    // Push the fresh snapshot into Supabase so the Admin Panel + future
    // Supabase-backed clients see live deals.
    if (isSupabaseSyncConfigured()) {
      try {
        const combinedOffers = [...snapshot.offers, ...snapshot.nextWeekOffers];
        const syncResult = await syncDealsToSupabase(
          combinedOffers,
          snapshot.offerScopes,
          {
            nextWeekOfferIds: new Set(snapshot.nextWeekOffers.map((offer) => offer.id)),
            disabledStores: parseDisabledStores(appConfig.offersDisabledStores),
          },
        );
        appendBackendDebugLog('info', 'offers.supabaseSync.completed', {
          attempted: syncResult.attempted,
          upserted: syncResult.upserted,
          skipped: syncResult.skipped,
          staleExpired: syncResult.staleExpired,
          staleByStore: syncResult.staleByStore,
          staleExpireErrors: syncResult.staleExpireErrors.length,
          collisions: syncResult.collisions,
          currentBucketForcedTodayCount: syncResult.currentBucketForcedTodayCount,
          futureBucketForcedTomorrowCount: syncResult.futureBucketForcedTomorrowCount,
          errorsCount: syncResult.errors.length,
          durationMs: syncResult.durationMs,
        });
        // Append the same snapshot to offer_history. Fail-soft: a history
        // error never blocks the live-deals sync. scanType=one_click_ai
        // because this branch runs at the end of the One-Click-KI pipeline,
        // which is also the "Auto-Sync nach Refresh" path.
        const historyResult = await writeOfferHistory(
          combinedOffers as Array<typeof combinedOffers[number] & Record<string, unknown>>,
          { scanType: 'one_click_ai' },
        );
        appendBackendDebugLog('info', 'offers.offerHistory.completed', {
          snapshotId: historyResult.snapshotId,
          scanRunId: historyResult.scanRunId,
          attempted: historyResult.attempted,
          written: historyResult.written,
          expired: historyResult.expired,
          errors: historyResult.errors.length,
          durationMs: historyResult.durationMs,
        });
        // Fresh deals are in Supabase → rebuild the deal⇄recipe-ingredient
        // matches so Cheffity shows real offer products in recipe details.
        await runDealRecipeMatchSafe('one_click_ai');
        if (syncResult.errors.length > 0) {
          snapshot.warnings = [
            ...snapshot.warnings,
            `Supabase-Sync: ${syncResult.errors.length} Fehler (${syncResult.upserted}/${syncResult.attempted} synchronisiert).`,
          ];
          await saveSnapshot();
        }
      } catch (syncError) {
        appendBackendDebugLog('error', 'offers.supabaseSync.failed', {
          error: syncError instanceof Error ? syncError.message : String(syncError),
        });
      }
    } else {
      appendBackendDebugLog('warn', 'offers.supabaseSync.notConfigured');
    }
  } catch (error) {
    const cancelled = error instanceof PipelineCancelledError;
    const message = cancelled
      ? 'One-Click-KI vom Nutzer abgebrochen.'
      : error instanceof Error
        ? error.message
        : 'Unbekannter One-Click-KI-Fehler';
    ingestState.running = false;
    ingestState.finishedAt = new Date().toISOString();
    ingestState.message = cancelled ? message : 'One-Click-KI fehlgeschlagen.';
    ingestState.lastError = message;
    if (cancelled) {
      finishAiRescanStateCancelled(message);
    } else {
      finishAiRescanStateError(message);
    }
    finishOneClickAiError(message);

    appendBackendDebugLog(cancelled ? 'info' : 'error', 'offers.oneClickAi.failed', {
      error: message,
      cancelled,
    });

    throw error;
  } finally {
    oneClickAiAbortController = null;
  }
}

function canStartOneClickAiLive(): { ok: true } | { ok: false; status: number; error: string } {
  if (ingestState.running) {
    return {
      ok: false,
      status: 409,
      error: 'One-Click-KI nicht moeglich waehrend ein Refresh laeuft.',
    };
  }

  if (aiRescanState.running || aiRescanBackgroundTask) {
    return {
      ok: false,
      status: 409,
      error: 'One-Click-KI nicht moeglich waehrend ein KI-Rescan laeuft.',
    };
  }

  if (oneClickAiState.running || oneClickAiBackgroundTask) {
    return {
      ok: false,
      status: 409,
      error: 'One-Click-KI laeuft bereits.',
    };
  }

  return { ok: true };
}

// Gate + preflight for starting One-Click-KI. It re-ingests + KI-scans the WHOLE
// snapshot (typically 2000+ offers) — far too large for one click with a local
// 14B model, and exactly the run that ground for hours. We therefore require an
// explicit forceAll confirmation (the admin button asks first), then run the
// Ollama preflight so a dead/500-ing Ollama can never start the job.
async function prepareOneClickAiStart(
  rawBody: unknown,
): Promise<
  | { ok: true }
  | { ok: false; status: number; error: string; reason?: string; requiresForceAll?: boolean }
> {
  const validation = oneClickAiRequestSchema.safeParse(rawBody ?? {});
  if (!validation.success) {
    return { ok: false, status: 400, error: 'Ungueltige Payload.' };
  }

  const allowed = canStartOneClickAiLive();
  if (!allowed.ok) return allowed;

  if (validation.data.forceAll !== true) {
    return {
      ok: false,
      status: 409,
      requiresForceAll: true,
      error:
        'One-Click-KI scannt ALLE Angebote neu (sehr gross fuer ein lokales Modell). ' +
        'Bitte bewusst mit forceAll=true bestaetigen — oder die store-spezifische ' +
        '„KI pruefen & verbessern" in der Datenqualitaet nutzen.',
    };
  }

  const preflight = await ensureScanPreflight(true);
  if (!preflight.ok) return preflight;
  return { ok: true };
}

function startOneClickAiBackground(): void {
  if (!oneClickAiState.running) {
    startOneClickAiState(
      snapshot.offers.length + snapshot.nextWeekOffers.length,
      snapshot.filteredOffers.length,
    );
    updateOneClickAiStage('preparing', 'One-Click-KI wird initialisiert...');
  }

  oneClickAiBackgroundTask = (async () => {
    try {
      await runOneClickAiLiveFlow();
    } catch {
      // Fehler sind bereits in runOneClickAiLiveFlow protokolliert.
    } finally {
      oneClickAiBackgroundTask = null;
    }
  })();
}

// ─── Wochen-Auto-Scan (Vollgas-Modus) ──────────────────────────────────────
// Scrapt alle Quellen außer den ausgeschlossenen Stores (REWE/nahkauf), läuft
// dann die KI-Kategorisierung im High-Quality-Profil — intern bewusst
// "forceAll" (kein Guard), aber MIT Preflight, GPU-Check, Fail-Fast und Cancel.
// REWE/nahkauf bleiben aus dem aktuellen Snapshot erhalten (Datei-Import).

const weeklyScanState: {
  running: boolean;
  phase: WeeklyScanPhase;
  message: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  isoWeek: string | null;
  excludedStores: string[];
  model: string | null;
  aiMode: string | null;
  trigger: 'manual' | 'scheduled' | null;
  total: number;
  processed: number;
  scrapedCount: number;
  scannedCount: number;
  aiClassifiedCount: number;
  fallbackCount: number;
  gpu: { name: string; freeMb: number; totalMb: number } | null;
  warnings: string[];
} = {
  running: false,
  phase: 'idle',
  message: 'idle',
  startedAt: null,
  finishedAt: null,
  lastError: null,
  isoWeek: null,
  excludedStores: [],
  model: null,
  aiMode: null,
  trigger: null,
  total: 0,
  processed: 0,
  scrapedCount: 0,
  scannedCount: 0,
  aiClassifiedCount: 0,
  fallbackCount: 0,
  gpu: null,
  warnings: [],
};

let weeklyScanBackgroundTask: Promise<void> | null = null;
let weeklyScanAbortController: AbortController | null = null;
let weeklyScanLastTriggeredIso: string | null = null;

function setWeeklyPhase(phase: WeeklyScanPhase, message: string): void {
  weeklyScanState.phase = phase;
  weeklyScanState.message = message;
}

function canStartWeeklyScan(): { ok: true } | { ok: false; status: number; error: string } {
  if (ingestState.running) {
    return { ok: false, status: 409, error: 'Wochen-Auto-Scan nicht moeglich waehrend ein Refresh/Ingest laeuft.' };
  }
  if (aiRescanState.running || aiRescanBackgroundTask) {
    return { ok: false, status: 409, error: 'Wochen-Auto-Scan nicht moeglich waehrend ein KI-Rescan laeuft.' };
  }
  if (oneClickAiState.running || oneClickAiBackgroundTask) {
    return { ok: false, status: 409, error: 'Wochen-Auto-Scan nicht moeglich waehrend One-Click-KI laeuft.' };
  }
  if (weeklyScanState.running || weeklyScanBackgroundTask) {
    return { ok: false, status: 409, error: 'Wochen-Auto-Scan laeuft bereits.' };
  }
  return { ok: true };
}

function throwIfWeeklyCancelled(controller: AbortController): void {
  if (controller.signal.aborted) {
    throw new PipelineCancelledError();
  }
}

async function runWeeklyAutoScanFlow(trigger: 'manual' | 'scheduled'): Promise<void> {
  const excluded = parseExcludedStores(appConfig.weeklyScanExcludedStores);
  const profile = resolveWeeklyScanProfile({
    aiMode: appConfig.weeklyScanAiMode,
    forceAll: appConfig.weeklyScanForceAll,
    centralTimeoutMs: appConfig.ollamaTimeoutMs,
    centralBatchSize: appConfig.ollamaBatchSize,
    centralMaxFailures: appConfig.ollamaMaxConsecutiveFailures,
    weeklyTimeoutMs: appConfig.weeklyScanOllamaTimeoutMs,
    weeklyBatchSize: appConfig.weeklyScanOllamaBatchSize,
    allowCpu: appConfig.weeklyScanAllowCpu,
  });
  const model = resolveOllamaModel();
  const isoWeek = isoWeekLabel(new Date());

  // Reset + start state.
  weeklyScanState.running = true;
  weeklyScanState.phase = 'preflight';
  weeklyScanState.message = 'Wochen-Auto-Scan gestartet.';
  weeklyScanState.startedAt = new Date().toISOString();
  weeklyScanState.finishedAt = null;
  weeklyScanState.lastError = null;
  weeklyScanState.isoWeek = isoWeek;
  weeklyScanState.excludedStores = excluded;
  weeklyScanState.model = model;
  weeklyScanState.aiMode = profile.aiMode;
  weeklyScanState.trigger = trigger;
  weeklyScanState.total = 0;
  weeklyScanState.processed = 0;
  weeklyScanState.scrapedCount = 0;
  weeklyScanState.scannedCount = 0;
  weeklyScanState.aiClassifiedCount = 0;
  weeklyScanState.fallbackCount = 0;
  weeklyScanState.gpu = null;
  weeklyScanState.warnings = [];

  // Use ingestState as the shared "heavy job running" flag so manual rescans /
  // one-click / refresh are blocked while the weekly scan runs (and vice versa).
  ingestState.running = true;
  ingestState.startedAt = new Date().toISOString();
  ingestState.finishedAt = null;
  ingestState.lastError = null;
  ingestState.message = `Wochen-Auto-Scan ${isoWeek} laeuft…`;

  const controller = new AbortController();
  weeklyScanAbortController = controller;

  appendBackendDebugLog('info', 'offers.weeklyAutoScan.started', {
    trigger, isoWeek, excluded, model, aiMode: profile.aiMode,
    ollamaTimeoutMs: profile.ollamaTimeoutMs, requireGpu: profile.requireGpu,
  });

  try {
    // PHASE 1 — Preflight: Ollama erreichbar + Modell + Smoke-Test, dann GPU.
    setWeeklyPhase('preflight', 'Preflight: Ollama wird geprueft…');
    const pf = await ensureScanPreflight(true);
    if (!pf.ok) {
      throw new Error(`Preflight fehlgeschlagen: ${pf.error}`);
    }
    throwIfWeeklyCancelled(controller);

    setWeeklyPhase('preflight', 'Preflight: GPU/VRAM wird geprueft…');
    // The smoke-test above just loaded the model into VRAM, so a "free VRAM"
    // check would now wrongly see the target model itself as consumed memory.
    // Pass the model's actual GPU residency so the preflight accepts a fully
    // loaded model (and still rejects a partial CPU offload).
    const loadedModel = await resolveLoadedModelGpuStatus(model);
    const gpu = await runGpuPreflight({ modelLabel: model, loadedModel }).catch(() => null);
    if (gpu && gpu.ok) {
      if (gpu.gpu) {
        weeklyScanState.gpu = { name: gpu.gpu.name, freeMb: gpu.gpu.freeMb, totalMb: gpu.gpu.totalMb };
      }
      if (gpu.warning) weeklyScanState.warnings.push(gpu.warning);
      if (gpu.loadedFull && gpu.message) {
        setWeeklyPhase('preflight', gpu.message);
        appendBackendDebugLog('info', 'offers.weeklyAutoScan.gpuLoadedFull', {
          model, message: gpu.message,
          gpuLayers: loadedModel?.gpuLayers ?? null,
          totalLayers: loadedModel?.totalLayers ?? null,
        });
      }
    } else if (gpu && !gpu.ok) {
      if (gpu.gpu) weeklyScanState.gpu = { name: gpu.gpu.name, freeMb: gpu.gpu.freeMb, totalMb: gpu.gpu.totalMb };
      // Full-power mode must not silently accept CPU offload.
      if (profile.requireGpu) {
        throw new Error(gpu.message);
      }
      weeklyScanState.warnings.push(`GPU-Hinweis: ${gpu.message}`);
    }
    throwIfWeeklyCancelled(controller);

    // PHASE 2 — Scrape: alle Quellen AUSSER den ausgeschlossenen UND den per
    // Policy deaktivierten Stores (ALDI SÜD/NORD, Lidl — unsichere Quelle, kein
    // Fetch/OCR/Vision/Prospekt).
    const disabled = parseDisabledStores(appConfig.offersDisabledStores);
    setWeeklyPhase('scrape', `Scrape: alle Quellen ausser ${[...excluded, ...disabled].join(', ')}…`);
    const scraped = await runNationalAndLocalIngest({
      locationFilter: defaultLocationFilter,
      tryOllama: false,
      excludeStoreChains: [...excluded, ...disabled],
      onProgress: (scope, message, total, completed) => {
        if (typeof total === 'number') weeklyScanState.total = total;
        if (typeof completed === 'number') weeklyScanState.processed = completed;
        const scopeLabel = scope === 'national' ? 'National' : 'Lokal';
        weeklyScanState.message = `Scrape ${scopeLabel}: ${message}`;
      },
    });
    throwIfWeeklyCancelled(controller);

    // Safety net: drop any excluded OR disabled store that slipped through
    // (cache, local…). Disabled shops must never reach the snapshot.
    const freshOffers = scraped.offers.filter(
      (offer) =>
        !isStoreExcluded(offer.storeChain, excluded) &&
        !isStoreDisabled(offer.storeChain, disabled),
    );
    weeklyScanState.scrapedCount = freshOffers.length;
    if (freshOffers.length === 0) {
      throw new Error(
        `Scrape lieferte 0 Angebote (ohne ${excluded.join(', ')}). Snapshot bleibt unveraendert.`,
      );
    }

    // PHASE 3 — KI: Food/Non-Food + Kategorie + Produktinfos (aichef_offers).
    setWeeklyPhase('ai', `KI-Kategorisierung (${profile.aiMode}, ${freshOffers.length} Angebote)…`);
    weeklyScanState.total = freshOffers.length;
    weeklyScanState.processed = 0;
    const categorization = await runOffersCategorizerPipeline(freshOffers, {
      tryOllama: true,
      mode: appConfig.offerWeekMode,
      engine: 'aichef_offers',
      ollamaTimeoutMs: profile.ollamaTimeoutMs,
      signal: controller.signal,
      onProgress: (progress) => {
        weeklyScanState.total = progress.total || weeklyScanState.total;
        weeklyScanState.processed = progress.processed;
        weeklyScanState.message = `KI: ${progress.processed}/${progress.total}`;
      },
    });
    throwIfWeeklyCancelled(controller);

    // Data integrity (same guard as the manual rescan): 0 KI-Treffer bei
    // aktivierter KI = Fehler, NICHT als Erfolg den Snapshot überschreiben.
    if (
      isZeroAiClassificationFailure({
        tryOllama: true,
        scannedCount: categorization.scannedCount,
        aiClassifiedCount: categorization.aiClassifiedCount,
      })
    ) {
      throw new Error(
        `KI lieferte 0 Treffer bei ${categorization.scannedCount} Angeboten ` +
          `(alles Regel-Fallback). Snapshot unveraendert — Ollama/GPU pruefen.`,
      );
    }
    weeklyScanState.scannedCount = categorization.scannedCount;
    weeklyScanState.aiClassifiedCount = categorization.aiClassifiedCount;
    weeklyScanState.fallbackCount = categorization.fallbackCount;

    // PHASE 4 — Filter + Merge: REWE/nahkauf aus dem aktuellen Snapshot bleiben
    // erhalten; alle anderen Stores werden durch den frischen Scrape ersetzt.
    setWeeklyPhase('filter', `Food-Filter + Merge (behalte ${excluded.join(', ')})…`);
    const { retained } = partitionExcludedFromBuckets(
      {
        current: snapshot.offers,
        next: snapshot.nextWeekOffers,
        filtered: snapshot.filteredOffers,
      },
      excluded,
    );
    const strict = filterOffersStrictFood(categorization.offers);
    const split = splitOffersByWeek(strict.offers);
    const recategorized: SnapshotBuckets = {
      current: split.current,
      next: split.next,
      filtered: dedupeOffersById([...categorization.filteredOffers, ...strict.removedOffers]),
    };
    const merged = mergeScopedRescan(retained, recategorized);
    snapshot.offers = merged.current;
    snapshot.nextWeekOffers = merged.next;
    snapshot.filteredOffers = merged.filtered;
    snapshot.offerScopes = mergeOfferScopeMaps(snapshot.offerScopes, scraped.offerScopes);
    snapshot.updatedAt = new Date().toISOString();
    snapshot.warnings = sanitizeWarnings([
      ...scraped.warnings,
      ...categorization.warnings,
      ...weeklyScanState.warnings,
      `Wochen-Auto-Scan ${isoWeek}: ${snapshot.offers.length} Live, ` +
        `${snapshot.nextWeekOffers.length} Naechste-Woche, ${snapshot.filteredOffers.length} Filtered. ` +
        `Ausgeschlossen (manuell per Datei): ${excluded.join(', ')}.`,
    ]);
    await saveSnapshot();

    // PHASE 5 — History + optionaler Supabase-Sync (nur wenn aktiviert).
    setWeeklyPhase('history', `Scan-Run ${isoWeek} + Offer-History werden gespeichert…`);
    const combinedOffers = [...snapshot.offers, ...snapshot.nextWeekOffers];
    if (isSupabaseSyncConfigured() && appConfig.weeklyScanAutoSync) {
      try {
        const syncResult = await syncDealsToSupabase(combinedOffers, snapshot.offerScopes, {
          nextWeekOfferIds: new Set(snapshot.nextWeekOffers.map((offer) => offer.id)),
          disabledStores: parseDisabledStores(appConfig.offersDisabledStores),
        });
        appendBackendDebugLog('info', 'offers.weeklyAutoScan.supabaseSync', {
          upserted: syncResult.upserted, skipped: syncResult.skipped,
          staleExpired: syncResult.staleExpired, staleByStore: syncResult.staleByStore,
          collisions: syncResult.collisions,
          currentBucketForcedTodayCount: syncResult.currentBucketForcedTodayCount,
          futureBucketForcedTomorrowCount: syncResult.futureBucketForcedTomorrowCount,
          errors: syncResult.errors.length,
        });
        await runDealRecipeMatchSafe('weekly_auto_scan');
      } catch (syncError) {
        appendBackendDebugLog('error', 'offers.weeklyAutoScan.supabaseSync.failed', {
          error: syncError instanceof Error ? syncError.message : String(syncError),
        });
      }
    }
    try {
      await writeOfferHistory(
        combinedOffers as Array<typeof combinedOffers[number] & Record<string, unknown>>,
        { scanType: 'auto_sync' },
      );
    } catch (historyError) {
      appendBackendDebugLog('error', 'offers.weeklyAutoScan.offerHistory.failed', {
        error: historyError instanceof Error ? historyError.message : String(historyError),
      });
    }

    // Done.
    weeklyScanState.running = false;
    weeklyScanState.phase = 'done';
    weeklyScanState.finishedAt = new Date().toISOString();
    weeklyScanState.message =
      `Wochen-Auto-Scan ${isoWeek} fertig: ${snapshot.offers.length} Live, ` +
      `${categorization.aiClassifiedCount} per KI, ${categorization.fallbackCount} per Regeln.`;
    ingestState.running = false;
    ingestState.finishedAt = new Date().toISOString();
    ingestState.message = weeklyScanState.message;

    appendBackendDebugLog('info', 'offers.weeklyAutoScan.completed', {
      isoWeek,
      liveCount: snapshot.offers.length,
      nextWeekCount: snapshot.nextWeekOffers.length,
      filteredCount: snapshot.filteredOffers.length,
      aiClassifiedCount: categorization.aiClassifiedCount,
      fallbackCount: categorization.fallbackCount,
      excluded,
    });
  } catch (error) {
    const cancelled = error instanceof PipelineCancelledError;
    const message = cancelled
      ? 'Wochen-Auto-Scan vom Nutzer abgebrochen.'
      : error instanceof Error
        ? error.message
        : 'Unbekannter Wochen-Auto-Scan-Fehler';
    weeklyScanState.running = false;
    weeklyScanState.phase = cancelled ? 'cancelled' : 'error';
    weeklyScanState.finishedAt = new Date().toISOString();
    weeklyScanState.lastError = message;
    weeklyScanState.message = message;
    ingestState.running = false;
    ingestState.finishedAt = new Date().toISOString();
    ingestState.lastError = message;
    ingestState.message = cancelled ? message : 'Wochen-Auto-Scan fehlgeschlagen.';
    appendBackendDebugLog(cancelled ? 'info' : 'error', 'offers.weeklyAutoScan.failed', {
      cancelled, error: message,
    });
    // Snapshot was never mutated (we throw before the apply step) — good offers
    // are preserved on every failure/cancel path.
  } finally {
    weeklyScanAbortController = null;
  }
}

function startWeeklyAutoScanBackground(trigger: 'manual' | 'scheduled'): void {
  weeklyScanLastTriggeredIso = new Date().toISOString();
  weeklyScanBackgroundTask = (async () => {
    try {
      await runWeeklyAutoScanFlow(trigger);
    } catch {
      // Errors are already recorded in weeklyScanState by the flow.
    } finally {
      weeklyScanBackgroundTask = null;
    }
  })();
}

// Lightweight in-process scheduler. Disabled unless WEEKLY_SCAN_ENABLED=true.
// Polls once a minute and fires on the configured weekday/time at most once per
// calendar day (see shouldRunWeeklyScanNow). The PowerShell script
// scripts/run-weekly-offer-scan.ps1 is the alternative for Windows Task Scheduler.
function startWeeklyScanScheduler(): void {
  if (!appConfig.weeklyScanEnabled) {
    appendBackendDebugLog('info', 'offers.weeklyAutoScan.scheduler.disabled', {});
    return;
  }
  appendBackendDebugLog('info', 'offers.weeklyAutoScan.scheduler.enabled', {
    day: appConfig.weeklyScanDay, time: appConfig.weeklyScanTime,
  });
  const tick = (): void => {
    try {
      const should = shouldRunWeeklyScanNow({
        now: new Date(),
        enabled: appConfig.weeklyScanEnabled,
        day: appConfig.weeklyScanDay,
        time: appConfig.weeklyScanTime,
        lastTriggeredIso: weeklyScanLastTriggeredIso,
        running: weeklyScanState.running || Boolean(weeklyScanBackgroundTask),
      });
      if (should && canStartWeeklyScan().ok) {
        appendBackendDebugLog('info', 'offers.weeklyAutoScan.scheduler.fire', {
          day: appConfig.weeklyScanDay, time: appConfig.weeklyScanTime,
        });
        startWeeklyAutoScanBackground('scheduled');
      }
    } catch {
      // Never let a scheduler tick crash the process.
    }
  };
  const timer = setInterval(tick, 60_000);
  timer.unref?.();
}

// ─── Angebots-Scan 2.0 (zweiphasiger Scan) ──────────────────────────────────
// Phase 1 (Schnellscan): scrape → Kategorie/Food-Non-Food → Broken-Image-Check →
// Snapshot. 100 %-sicheres Non-Food geht direkt in den filtered-Bucket; Food +
// Unsicher bleiben sichtbar. KEINE teure Nährwert/Halal/Allergen-Analyse hier.
// Phase 2 (Food-Analyse): nur echte/unsichere Lebensmittel aus Phase 1 werden
// tief analysiert (Nährwerte, Allergene, Halal/Haram, vegan/vegetarisch,
// Alkohol/Gelatine/Schwein/Fleisch). Bekannte Produkte werden wiederverwendet,
// locked/manual Daten nie überschrieben. Beide Phasen sind einzeln startbar und
// teilen sich den ingestState-„heavy job läuft"-Guard mit 1.0/Wochen-Auto-Scan.

const scanV2State: ScanV2Status = createInitialScanV2Status();
let scanV2BackgroundTask: Promise<void> | null = null;
let scanV2AbortController: AbortController | null = null;
// Pause is cooperative: the pause endpoint sets this flag AND aborts the active
// controller. The abort interrupts the in-flight Python batch immediately (so
// pause is responsive), but `processed`/the checkpoint only ever advance on a
// FULLY-completed + persisted batch — so resume re-runs at most the interrupted
// batch and never double-counts. The flag lets the catch tell "paused" apart
// from a real "cancel" (both surface as PipelineCancelledError).
let scanV2PauseRequested = false;
const SCAN_V2_CHECKPOINT_FILE = resolveCheckpointFile();
// Lightweight in-memory mirror of the on-disk checkpoint meta so the status
// endpoint never has to read+parse the (large) checkpoint on every poll.
let scanV2CheckpointMeta: ScanV2CheckpointMeta | null = null;

/** Thrown to unwind a run that was PAUSED (not cancelled). Keeps the checkpoint
 *  and leaves the snapshot untouched, exactly like a cancel, but reports a
 *  resumable "paused" state instead of "cancelled". */
class ScanV2PausedError extends Error {
  public constructor(message = 'Angebots-Scan 2.0 pausiert.') {
    super(message);
    this.name = 'ScanV2PausedError';
  }
}

/** Thrown by the snapshot safety gate (Datenqualität #5) when the freshly built
 *  buckets look broken (REWE lost, several large shops 0 current, live collapse).
 *  Raised BEFORE saveSnapshot, so the productive snapshot stays untouched; the
 *  run ends in an honest "quality_failed" error and the checkpoint is kept. */
class ScanQualityGateError extends Error {
  public readonly failedChecks: string[];
  public readonly reasons: string[];
  /** Begrenzte Beispielnamen der blockierenden Angebote (für den Status). */
  public readonly examples: string[];
  public constructor(reasons: string[], failedChecks: string[], examples: string[] = []) {
    super(
      `Qualitäts-Gate hat den Scan verworfen (Snapshot NICHT ersetzt): ${reasons.join(' ')}`,
    );
    this.name = 'ScanQualityGateError';
    this.failedChecks = failedChecks;
    this.reasons = reasons;
    this.examples = examples;
  }
}

/**
 * Run the snapshot safety gate against the candidate buckets and throw
 * {@link ScanQualityGateError} when it fails — the caller must call this BEFORE
 * mutating `snapshot`/saveSnapshot so a bad scan can never overwrite a good
 * snapshot. `previous` is captured at finalize start (still the last good state).
 */
// Vollständige Subquellenbilanz des letzten Commit-Versuchs (Task P5/P6) — vom
// Safety-Gate gefüllt und vom Scan-Report/Store-Health gerendert.
let lastSubSourceOutcomes: SubSourceOutcome[] = [];
// Rohe Subquellen-Diagnosen des letzten Scrapes (Phase 1), die Phase 2 für ihr
// Commit-Gate weiterverwendet, falls kein Resume-Checkpoint sie trägt.
let lastScrapeSubSourceDiagnostics: SubSourceDiagnostic[] = [];

export function getLastSubSourceOutcomes(): SubSourceOutcome[] {
  return lastSubSourceOutcomes;
}

function assertSnapshotSafeToCommit(
  previous: { offers: Offer[]; nextWeekOffers: Offer[]; filteredOffers: Offer[] },
  candidate: { offers: Offer[]; nextWeekOffers: Offer[]; filteredOffers: Offer[] },
  phase: 'phase1' | 'phase2',
  scrapeWarnings: readonly string[] = [],
  subSourceDiagnostics: readonly SubSourceDiagnostic[] = [],
): SubSourceOutcome[] {
  // Scope-aware gate: only the stores THIS run is responsible for trigger
  // store-specific rules (Lidl minimum, nahkauf-required, store loss). A
  // REWE-only Phase-2 run therefore never fails on missing Lidl/nahkauf.
  const scope = scanV2State.scope ?? allStoresScope();
  const result = evaluateSnapshotSafety({
    previous,
    candidate,
    excludedStores: parseExcludedStores(appConfig.weeklyScanExcludedStores),
    // Per Policy deaktivierte Shops (ALDI SÜD/NORD, Lidl): nie für ein „verloren"/
    // „unter Minimum"/„0 current" verantwortlich — sie werden gar nicht gescannt.
    disabledStores: parseDisabledStores(appConfig.offersDisabledStores),
    now: new Date(),
    // Harte Datenqualitäts-Gates (Task 7): Lidl unter Mindestmenge, nahkauf 0
    // ohne ehrlichen Grund, REWE-Import critical, Fragmente/Non-Food im Feed.
    storeMinimums: SCAN_STORE_MINIMUMS,
    scrapeWarnings,
    // Strukturierte Subquellen-/Prospekt-Diagnosen (Task P5): NUR ein expliziter
    // fetch_failed/parse_failed mit erheblichem Verlust blockiert — kein Warnungstext.
    subSourceDiagnostics: sanitizeSubSourceDiagnostics([...subSourceDiagnostics]),
    reweImportHealth: lastReweImportReport?.importHealth ?? null,
    scope,
  });
  if (!result.ok) {
    appendBackendDebugLog('error', 'offers.scanV2.qualityGate.failed', {
      phase,
      scope: describeScope(scope),
      checkedStores: result.scope.checkedStores,
      skippedStores: result.scope.skippedStores,
      failedChecks: result.failedChecks,
      reasons: result.reasons,
      previousLive: previous.offers.length,
      candidateLive: candidate.offers.length,
      examples: result.examples,
      subSourceOutcomes: result.subSourceOutcomes,
    });
    throw new ScanQualityGateError(result.reasons, result.failedChecks, result.examples);
  }
  appendBackendDebugLog('info', 'offers.scanV2.qualityGate.passed', {
    phase,
    scope: describeScope(scope),
    checkedStores: result.scope.checkedStores,
    skippedStores: result.scope.skippedStores,
    subSourceOutcomes: result.subSourceOutcomes,
  });
  return result.subSourceOutcomes;
}

function scanV2ImageConcurrency(): number {
  const raw = Number(process.env.SCAN_V2_IMAGE_CONCURRENCY ?? '8');
  return Number.isFinite(raw) && raw > 0 ? Math.min(32, Math.round(raw)) : 8;
}

function scanV2ImageTimeoutMs(): number {
  const raw = Number(process.env.SCAN_V2_IMAGE_TIMEOUT_MS ?? '5000');
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 5000;
}

// Phase 1 (Schnellscan, soft-Ollama category) is light → bigger batches keep the
// Python startup overhead negligible. Phase 2 (Qwen3:14b deep analysis) is heavy
// → small batches mean frequent checkpoints + a responsive pause.
function scanV2Phase1BatchSize(): number {
  const raw = Number(process.env.SCAN_V2_PHASE1_BATCH_SIZE ?? '200');
  return Number.isFinite(raw) && raw > 0 ? Math.max(1, Math.round(raw)) : 200;
}

function scanV2Phase2BatchSize(): number {
  const raw = Number(process.env.SCAN_V2_PHASE2_BATCH_SIZE ?? '15');
  return Number.isFinite(raw) && raw > 0 ? Math.max(1, Math.round(raw)) : 15;
}

function setScanV2Phase(phase: ScanV2Status['phase'], message: string): void {
  scanV2State.phase = phase;
  scanV2State.message = message;
}

function throwIfScanV2Cancelled(controller: AbortController): void {
  if (controller.signal.aborted) {
    throw new PipelineCancelledError();
  }
}

/** Persist a checkpoint atomically and mirror its meta into the status. Called
 *  after each completed batch so progress survives a crash/restart. */
async function persistScanV2Checkpoint(checkpoint: ScanV2Checkpoint): Promise<void> {
  await writeCheckpointAtomic(SCAN_V2_CHECKPOINT_FILE, checkpoint);
  scanV2CheckpointMeta = summarizeCheckpoint(checkpoint);
  scanV2State.checkpointAvailable = true;
}

/** Drop the checkpoint (clean finish / explicit cancel / overwrite). */
async function discardScanV2Checkpoint(): Promise<void> {
  await clearCheckpoint(SCAN_V2_CHECKPOINT_FILE);
  scanV2CheckpointMeta = null;
  scanV2State.checkpointAvailable = false;
}

function buildScanV2Checkpoint(input: {
  mode: ScanV2Mode;
  phase: ScanV2Status['phase'];
  startedAt: string;
  total: number;
  processed: number;
  phase1?: ScanV2CheckpointPhase1 | null;
  phase2?: ScanV2CheckpointPhase2 | null;
  diagnostics?: Record<string, unknown>;
}): ScanV2Checkpoint {
  return {
    version: SCAN_V2_CHECKPOINT_VERSION,
    mode: input.mode,
    phase: input.phase,
    startedAt: input.startedAt,
    pausedAt: new Date().toISOString(),
    total: input.total,
    processed: input.processed,
    // Persist the active scope so resume continues with EXACTLY the same shops.
    scope: scanV2State.scope ?? allStoresScope(),
    phase1: input.phase1 ?? null,
    phase2: input.phase2 ?? null,
    diagnostics: input.diagnostics ?? {},
  };
}

// Startup: detect a leftover pause-checkpoint so the admin UI offers Resume even
// after a backend restart (the in-memory run state is reset on boot). Acceptance
// criterion: pause at 1768/2164 → restart → /resume continues from there.
async function initScanV2CheckpointOnBoot(): Promise<void> {
  try {
    const checkpoint = await readCheckpoint(SCAN_V2_CHECKPOINT_FILE);
    if (!checkpoint) return;
    scanV2CheckpointMeta = summarizeCheckpoint(checkpoint);
    scanV2State.mode = checkpoint.mode;
    scanV2State.phase = 'paused';
    scanV2State.paused = true;
    scanV2State.startedAt = checkpoint.startedAt;
    scanV2State.pausedAt = checkpoint.pausedAt;
    scanV2State.total = checkpoint.total;
    scanV2State.processed = checkpoint.processed;
    scanV2State.scope = checkpoint.scope ? normalizeScope(checkpoint.scope) : null;
    scanV2State.checkpointAvailable = true;
    scanV2State.message = `${summarizePausedMessage(checkpoint)} (Checkpoint nach Neustart gefunden — /resume möglich).`;
    appendBackendDebugLog('info', 'offers.scanV2.checkpoint.detectedOnBoot', {
      mode: checkpoint.mode, phase: checkpoint.phase, processed: checkpoint.processed, total: checkpoint.total,
    });
  } catch (error) {
    // A corrupt checkpoint at boot must NOT crash the server. Leave state idle;
    // /resume will 422 cleanly and /clear-checkpoint removes the bad file.
    appendBackendDebugLog('error', 'offers.scanV2.checkpoint.bootReadFailed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
void initScanV2CheckpointOnBoot();

function canStartScanV2(): { ok: true } | { ok: false; status: number; error: string } {
  if (ingestState.running) {
    return { ok: false, status: 409, error: 'Angebots-Scan 2.0 nicht moeglich waehrend ein Refresh/Ingest laeuft.' };
  }
  if (aiRescanState.running || aiRescanBackgroundTask) {
    return { ok: false, status: 409, error: 'Angebots-Scan 2.0 nicht moeglich waehrend ein KI-Scan laeuft.' };
  }
  if (oneClickAiState.running || oneClickAiBackgroundTask) {
    return { ok: false, status: 409, error: 'Angebots-Scan 2.0 nicht moeglich waehrend Angebots-Scan 1.0 laeuft.' };
  }
  if (weeklyScanState.running || weeklyScanBackgroundTask) {
    return { ok: false, status: 409, error: 'Angebots-Scan 2.0 nicht moeglich waehrend ein Wochen-Auto-Scan laeuft.' };
  }
  if (scanV2State.running || scanV2BackgroundTask) {
    return { ok: false, status: 409, error: 'Angebots-Scan 2.0 laeuft bereits.' };
  }
  if (lidlPageImageImportState.running) {
    return {
      ok: false,
      status: 409,
      error: 'Angebots-Scan 2.0 nicht moeglich waehrend der Lidl-Prospektbilder-Import laeuft.',
    };
  }
  return { ok: true };
}

// Accumulates the per-batch categorizer output so a paused run can persist its
// partial result and a resumed run can keep building on it.
interface CategorizerBatchAccumulator {
  food: Offer[];
  nonFood: Offer[];
  warnings: string[];
  aiClassifiedCount: number;
  fallbackCount: number;
}

/**
 * Run `items` (starting at `startIndex`) through the categorizer in chunks of
 * `batchSize`. After every FULLY-completed batch the caller's `onBatchDone`
 * appends the result + persists a checkpoint, and the loop then honours a pause
 * request (`scanV2PauseRequested`) / cancel. Because the index only advances on a
 * committed batch, a pause mid-batch (the abort kills the Python child) loses at
 * most the interrupted batch — resume re-runs it, never double-counts it.
 */
async function runCategorizerBatches(opts: {
  items: readonly Offer[];
  startIndex: number;
  batchSize: number;
  controller: AbortController;
  runBatch: (batch: Offer[], baseIndex: number) => Promise<OffersCategorizerResult>;
  onBatchDone: (newIndex: number, result: OffersCategorizerResult) => Promise<void>;
}): Promise<void> {
  let index = Math.max(0, Math.min(opts.items.length, Math.floor(opts.startIndex || 0)));
  while (index < opts.items.length) {
    throwIfScanV2Cancelled(opts.controller);
    const batch = opts.items.slice(index, index + opts.batchSize);
    const result = await opts.runBatch(batch, index);
    index += batch.length;
    await opts.onBatchDone(index, result);
    // Pause requested between/after batches: stop with the checkpoint intact.
    if (scanV2PauseRequested) throw new ScanV2PausedError();
    throwIfScanV2Cancelled(opts.controller);
  }
}

// PHASE 1 — Schnellscan. Scrape + Kategorie + Food/Non-Food + Broken-Image-Check,
// dann Snapshot schreiben (App zeigt sofort nutzbare Angebote). Pausierbar: der
// Scrape wird einmal als Checkpoint gesichert, danach läuft die Kategorisierung
// in Batches mit Checkpoint nach jedem Batch — Resume überspringt den Scrape und
// setzt ab dem gespeicherten Index fort (nicht bei 0).
async function runScanV2Phase1(
  controller: AbortController,
  resume?: ScanV2CheckpointPhase1,
): Promise<void> {
  const startedAtIso = scanV2State.startedAt ?? new Date().toISOString();
  const mode = scanV2State.mode ?? 'phase1_phase2';
  // REWE/nahkauf werden NICHT mehr per Web-Scan geprüft (403/Captcha/Marktwahl) —
  // sie kommen ausschließlich über den manuellen Browser-/PDF-Import.
  const excluded = parseExcludedStores(appConfig.weeklyScanExcludedStores);
  // Per Policy DEAKTIVIERTE Shops (ALDI SÜD/NORD, Lidl): unsichere Quelle, werden
  // gar nicht erst gefetcht (kein HTTP/OCR/Vision/Prospekt) und nie im Snapshot
  // behalten. Anders als `excluded` werden sie NICHT preserved.
  const disabled = parseDisabledStores(appConfig.offersDisabledStores);

  let rawOffers: Offer[];
  let preservedExcluded: { current: Offer[]; next: Offer[]; filtered: Offer[] };
  let offerScopes: OfferScopeMap;
  let scrapeWarnings: string[];
  let subSourceDiagnostics: SubSourceDiagnostic[];
  let startIndex = 0;
  const acc: CategorizerBatchAccumulator = {
    food: resume ? [...resume.categorizedFood] : [],
    nonFood: resume ? [...resume.categorizedNonFood] : [],
    warnings: [],
    aiClassifiedCount: 0,
    fallbackCount: 0,
  };

  if (resume) {
    // Resume: NICHT neu scrapen — die rohen Angebote + Zwischenstand stehen im
    // Checkpoint. Ab dem gespeicherten Index weiter kategorisieren.
    rawOffers = resume.rawOffers;
    preservedExcluded = resume.preservedExcluded;
    offerScopes = (resume.offerScopes ?? {}) as OfferScopeMap;
    scrapeWarnings = resume.scrapeWarnings ?? [];
    // Resume erhält die strukturierten Subquellen-Diagnosen defensiv (Task P5):
    // sanitisiert wiederhergestellt, damit der Teilverlust-Schutz nicht still
    // verloren geht.
    subSourceDiagnostics = sanitizeSubSourceDiagnostics(resume.subSourceDiagnostics);
    startIndex = Math.max(0, Math.min(rawOffers.length, resume.processedIndex));
    setScanV2Phase(
      'resuming',
      `Phase 1 wird ab ${startIndex}/${rawOffers.length} fortgesetzt (kein erneuter Scrape)…`,
    );
  } else {
    setScanV2Phase('phase1_scraping', 'Phase 1: Angebote werden gesammelt…');
    const scraped = await runNationalAndLocalIngest({
      locationFilter: defaultLocationFilter,
      tryOllama: false,
      excludeStoreChains: [...excluded, ...disabled],
      // Abbruchsignal durchreichen: ein Cancel/Pause stoppt einen hängenden
      // Per-Store-Fetch sauber, statt still im Hintergrund weiterzulaufen.
      signal: controller.signal,
      onProgress: (scope, message, total, completed) => {
        if (typeof total === 'number') scanV2State.total = total;
        if (typeof completed === 'number') scanV2State.processed = completed;
        const scopeLabel = scope === 'national' ? 'National' : 'Lokal';
        setScanV2Phase('phase1_scraping', `Phase 1 Scrape ${scopeLabel}: ${message}`);
      },
    });
    throwIfScanV2Cancelled(controller);
    // Sicherheitsnetz: Falls ein ausgeschlossener ODER deaktivierter Store doch
    // durchrutscht (Cache, lokale Quelle), wird er hier verworfen.
    rawOffers = scraped.offers.filter(
      (offer) =>
        !isStoreExcluded(offer.storeChain, excluded) &&
        !isStoreDisabled(offer.storeChain, disabled),
    );
    offerScopes = scraped.offerScopes;
    scrapeWarnings = scraped.warnings;
    subSourceDiagnostics = sanitizeSubSourceDiagnostics(scraped.subSourceDiagnostics);
    // REWE/nahkauf-Angebote aus dem aktuellen Snapshot (manueller Import) JETZT
    // sichern, damit Resume sie auch nach einem Backend-Neustart bewahrt.
    const { retained } = partitionExcludedFromBuckets(
      { current: snapshot.offers, next: snapshot.nextWeekOffers, filtered: snapshot.filteredOffers },
      excluded,
    );
    preservedExcluded = retained;
  }
  scanV2State.phase1.scrapedCount = rawOffers.length;
  // Subquellen-Diagnosen des Scrapes für das Phase-2-Commit-Gate merken (Task P5).
  lastScrapeSubSourceDiagnostics = subSourceDiagnostics;

  // Soft-Ollama: Kategorie-KI nutzen, wenn Ollama bereits läuft, sonst
  // regelbasiert — Phase 1 muss schnell bleiben und startet kein Modell.
  const phase1Ollama = await isOllamaReachable(resolveOllamaHost()).catch(() => false);

  const total = rawOffers.length;
  scanV2State.total = total;
  scanV2State.processed = startIndex;
  setScanV2Phase('phase1_scraping', `Phase 1: Kategorisierung (${total} Angebote)…`);

  const persist = async (processedIndex: number): Promise<void> => {
    scanV2State.processed = processedIndex;
    await persistScanV2Checkpoint(
      buildScanV2Checkpoint({
        mode,
        phase: 'phase1_scraping',
        startedAt: startedAtIso,
        total,
        processed: processedIndex,
        phase1: {
          rawOffers,
          processedIndex,
          categorizedFood: acc.food,
          categorizedNonFood: acc.nonFood,
          preservedExcluded,
          offerScopes,
          scrapeWarnings,
          subSourceDiagnostics,
        },
        diagnostics: { phase1CategorizerWarnings: acc.warnings },
      }),
    );
  };

  // Plan up-front sichern, damit auch ein Pause im ersten Batch resumebar ist.
  await persist(startIndex);

  await runCategorizerBatches({
    items: rawOffers,
    startIndex,
    batchSize: scanV2Phase1BatchSize(),
    controller,
    runBatch: (batch, baseIndex) =>
      runOffersCategorizerPipeline(batch, {
        tryOllama: phase1Ollama,
        mode: appConfig.offerWeekMode,
        engine: 'offers_categorizer',
        signal: controller.signal,
        onProgress: (progress) => {
          scanV2State.total = total;
          scanV2State.processed = baseIndex + progress.processed;
          setScanV2Phase('phase1_scraping', `Phase 1: Kategorie ${scanV2State.processed}/${total}`);
        },
      }),
    onBatchDone: async (newIndex, result) => {
      acc.food.push(...result.offers);
      acc.nonFood.push(...result.filteredOffers);
      acc.warnings.push(...result.warnings);
      acc.aiClassifiedCount += result.aiClassifiedCount;
      acc.fallbackCount += result.fallbackCount;
      await persist(newIndex);
    },
  });
  throwIfScanV2Cancelled(controller);

  // ── Finalize Phase 1 (unverändert, jetzt aus den Akkumulatoren gespeist) ──
  // Strenger Regelfilter: 100 %-sicheres Non-Food nie sichtbar lassen.
  const strict = filterOffersStrictFood(acc.food);
  const food = strict.offers; // Food + Unsicher → sichtbar
  const nonFood = dedupeOffersById([...acc.nonFood, ...strict.removedOffers]); // Non-Food → filtered

  // Broken-Image-Check: ALLE Angebote prüfen, damit der Snapshot einen ehrlichen
  // imageStatus/brokenImage trägt.
  setScanV2Phase('phase1_image_check', 'Phase 1: Bilder werden geprüft (Broken-Image-Check)…');
  const imageCheck = await checkOffersImages([...food, ...nonFood], {
    concurrency: scanV2ImageConcurrency(),
    timeoutMs: scanV2ImageTimeoutMs(),
    signal: controller.signal,
    onProgress: (checked, imgTotal, broken) => {
      scanV2State.processed = checked;
      scanV2State.total = imgTotal;
      setScanV2Phase('phase1_image_check', `Phase 1 Bildcheck: ${checked}/${imgTotal} (${broken} broken)`);
    },
  });
  throwIfScanV2Cancelled(controller);

  const foodIds = new Set(food.map((offer) => offer.id));
  const checkedFood = imageCheck.offers.filter((offer) => foodIds.has(offer.id));
  const checkedNonFood = imageCheck.offers.filter((offer) => !foodIds.has(offer.id));

  // Zusatzklassifikation: internationale Lebensmittel regelbasiert markieren
  // (ersetzt NICHT die Hauptkategorie; läuft nur auf Food).
  const checkedFoodIntl = checkedFood.map((offer) => ({
    ...(offer as ScanV2Offer),
    internationalFood: classifyInternationalFood(offer),
  }));

  // Snapshot: Food in live/next aufteilen — NICHT nach ISO-Woche (die am Sonntag
  // Zukunftsangebote fälschlich live machte), sondern nach echter Gültigkeit am
  // Scan-Datum (Europe/Berlin). Zukunfts-Angebote (validFrom > heute oder
  // "ab-montag,-08.06.26" in der sourceUrl) → next; abgelaufene → verworfen.
  const liveSplit = splitOffersByLiveWindow(dedupeOffersById(checkedFoodIntl), {
    now: new Date(),
    weekBucketOf: (offer) => classifyOfferWeek(offer),
    maxValidityDays: appConfig.offerMaxValidityDays,
  });
  // REWE/nahkauf (manueller Import) aus dem gesicherten Checkpoint-Stand mergen,
  // NICHT vom frischen Scrape überschreiben — bleibt auch über Resume erhalten.
  const merged = mergeScopedRescan(preservedExcluded, {
    current: liveSplit.current,
    next: liveSplit.next,
    filtered: dedupeOffersById(checkedNonFood),
  });
  // Fragment-Quarantäne: "Tiefpreis"/"Fl."/"Dose" u. ä. dürfen NIE live stehen —
  // sie wandern (auch aus preserved-Manuell-Importen) in den Filtered-Bucket
  // mit reviewNeeded-Tag statt gelöscht zu werden.
  const fragCurrent = quarantineFragmentOffers(merged.current);
  const fragNext = quarantineFragmentOffers(merged.next);
  const fragmentWarnings: string[] = [];
  if (fragCurrent.quarantined.length + fragNext.quarantined.length > 0) {
    const names = [
      ...new Set(
        [...fragCurrent.quarantined, ...fragNext.quarantined].map((offer) => offer.name),
      ),
    ];
    fragmentWarnings.push(
      `${names.length} Fragment-Angebot(e) in Review-Quarantäne verschoben (nie live): ${names
        .slice(0, 6)
        .join(', ')}.`,
    );
  }
  const candidateFiltered = dedupeOffersById([
    ...merged.filtered,
    ...fragCurrent.quarantined,
    ...fragNext.quarantined,
  ]);
  // Finaler Non-Food-Gate VOR dem Safety-Gate: starke Non-Food-Signale (auch
  // mit falschem KI-Food-Verdikt wie "Grundnahrungsmittel") werden aus
  // current/next nach filtered repariert — das Safety-Gate prüft danach den
  // bereits reparierten Kandidaten.
  const nonFoodGate = applyFinalNonFoodGate({
    offers: fragCurrent.clean,
    nextWeekOffers: fragNext.clean,
    filteredOffers: candidateFiltered,
  });
  const nonFoodGateWarnings: string[] = [];
  if (nonFoodGate.movedCount > 0) {
    nonFoodGateWarnings.push(
      `Non-Food-Gate: ${nonFoodGate.movedCount} Angebot(e) mit klarem Non-Food-Signal aus Live/Naechste-Woche nach Filtered verschoben (z. B. ${nonFoodGate.movedExamples
        .slice(0, 4)
        .join(', ')}).`,
    );
  }
  // EDEKA-Schutz (P4): war die EDEKA-Quelle in diesem Lauf blockiert
  // (403/Captcha) und liefert 0 Angebote, darf der vorhandene gültige
  // EDEKA-Bestand NICHT durch 0 ersetzt werden — die vorherigen EDEKA-Angebote
  // werden atomar in den Kandidaten übernommen (andere Stores unberührt).
  const edekaPreserve = preserveBlockedStoreOffers({
    previous: {
      offers: snapshot.offers,
      nextWeekOffers: snapshot.nextWeekOffers,
      filteredOffers: snapshot.filteredOffers,
    },
    candidate: {
      offers: nonFoodGate.offers,
      nextWeekOffers: nonFoodGate.nextWeekOffers,
      filteredOffers: nonFoodGate.filteredOffers,
    },
    storeChain: 'EDEKA',
    blocked: Boolean(getLastEdekaDiagnostics()?.blocked),
  });
  if (edekaPreserve.preserved) {
    scrapeWarnings.push(
      `EDEKA blockiert — ${edekaPreserve.preservedCount} vorhandene EDEKA-Angebote aus dem letzten gültigen Snapshot behalten (nicht durch 0 ersetzt).`,
    );
  }
  // Safety-Gate (Datenqualität #5): wenn der frische Snapshot REWE verliert,
  // mehrere große Shops 0 current haben oder die Live-Liste einbricht, wird der
  // alte Snapshot BEHALTEN und der Scan als quality_failed beendet.
  lastSubSourceOutcomes = assertSnapshotSafeToCommit(
    { offers: snapshot.offers, nextWeekOffers: snapshot.nextWeekOffers, filteredOffers: snapshot.filteredOffers },
    edekaPreserve.buckets,
    'phase1',
    [...scrapeWarnings, ...acc.warnings],
    subSourceDiagnostics,
  );
  snapshot.offers = edekaPreserve.buckets.offers;
  snapshot.nextWeekOffers = edekaPreserve.buckets.nextWeekOffers;
  snapshot.filteredOffers = edekaPreserve.buckets.filteredOffers;
  snapshot.offerScopes = mergeOfferScopeMaps(snapshot.offerScopes, offerScopes);
  snapshot.updatedAt = new Date().toISOString();
  // Ehrlicher Phase-1-Split (zentrale classifyFoodDecision): nonFoodFilteredCount
  // ist NUR das regelbestätigte confirmed_non_food, uncertain zählt separat —
  // nie mehr „filteredCount pauschal = Non-Food". Gate/Rescue liefen in diesem
  // Pfad bereits und saveSnapshot reconciled idempotent, daher final.
  const phase1Decisions = summarizeFoodDecisions({
    offers: snapshot.offers,
    nextWeekOffers: snapshot.nextWeekOffers,
    filteredOffers: snapshot.filteredOffers,
  });
  snapshot.warnings = sanitizeWarnings([
    ...scrapeWarnings,
    ...acc.warnings,
    ...fragmentWarnings,
    ...nonFoodGateWarnings,
    `Angebots-Scan 2.0 Phase 1: ${snapshot.offers.length} Live, ${snapshot.nextWeekOffers.length} Naechste-Woche, ` +
      `${snapshot.filteredOffers.length} gefiltert (${phase1Decisions.confirmedNonFoodFilteredCount} Non-Food, ${phase1Decisions.uncertainFilteredCount} unklar/Review). ` +
      `REWE/nahkauf nicht web-gescannt (manueller Import bleibt erhalten). ` +
      `Bildcheck: ${imageCheck.imageCheckedCount} geprüft, ${imageCheck.brokenImageCount} broken.`,
  ]);
  await saveSnapshot({ enforceFoodReconciliation: true, scope: scanV2State.scope ?? allStoresScope() });

  scanV2State.phase1 = {
    scrapedCount: rawOffers.length,
    liveCount: snapshot.offers.length,
    nextWeekCount: snapshot.nextWeekOffers.length,
    filteredCount: snapshot.filteredOffers.length,
    nonFoodFilteredCount: phase1Decisions.confirmedNonFoodFilteredCount,
    uncertainFilteredCount: phase1Decisions.uncertainFilteredCount,
    imageCheckedCount: imageCheck.imageCheckedCount,
    brokenImageCount: imageCheck.brokenImageCount,
  };
  setScanV2Phase(
    'phase1_done',
    `Phase 1 fertig: ${snapshot.offers.length} Live, ${snapshot.nextWeekOffers.length} Naechste-Woche, ` +
      `${snapshot.filteredOffers.length} gefiltert, ${imageCheck.brokenImageCount} broken Bilder.`,
  );

  // Phase 1 ist im Snapshot committed. Bei phase1_phase2 hinterlassen wir einen
  // schlanken "phase1_done"-Marker, damit ein Pause in der winzigen Lücke vor
  // Phase 2 nicht Phase 1 erneut laufen lässt (Resume startet dann Phase 2 frisch).
  // Phase 2 überschreibt diesen Marker sofort mit ihrem eigenen Plan-Checkpoint.
  if (modeIncludesPhase2(mode)) {
    await persistScanV2Checkpoint(
      buildScanV2Checkpoint({
        mode,
        phase: 'phase1_done',
        startedAt: startedAtIso,
        total: snapshot.offers.length,
        processed: snapshot.offers.length,
        phase1: null,
        phase2: null,
      }),
    );
  }

  appendBackendDebugLog('info', 'offers.scanV2.phase1.completed', {
    scrapedCount: rawOffers.length,
    liveCount: snapshot.offers.length,
    nextWeekCount: snapshot.nextWeekOffers.length,
    filteredCount: snapshot.filteredOffers.length,
    imageCheckedCount: imageCheck.imageCheckedCount,
    brokenImageCount: imageCheck.brokenImageCount,
    excludedStores: excluded,
    resumed: Boolean(resume),
  });

  // Cheffity Auto-Sync: a Phase-1-ONLY run is now committed → push deals + run the
  // matcher. In phase1_phase2 this is skipped (Phase 2 follows and owns the sync),
  // so Cheffity is never synced twice. Quality-gate failures throw above this point
  // (snapshot not committed) and therefore never reach this hook. Fail-soft.
  if (shouldSyncAfterPhase1Commit(mode)) {
    await runCheffitySyncForCurrentSnapshot('scan_v2_phase1', { scanType: 'scan_v2_phase1' });
  }
}

// PHASE 2 — Food-Analyse. Nur echte/unsichere Lebensmittel werden tief
// analysiert; bekannte Produkte reuse, locked/manual nie überschrieben.
// Pausierbar: der Plan (welche Repräsentanten ans Modell gehen, plus die nicht
// vom Modell abhängigen Teile) wird gesichert; danach läuft der Modell-Lauf in
// kleinen Batches mit Checkpoint nach jedem Batch. Resume setzt ab dem Index
// fort und schickt bereits analysierte Kandidaten NICHT erneut an Qwen.
async function runScanV2Phase2(
  controller: AbortController,
  resume?: ScanV2CheckpointPhase2,
): Promise<void> {
  const startedMs = Date.now();
  const startedAtIso = scanV2State.startedAt ?? new Date().toISOString();
  const mode = scanV2State.mode ?? 'phase1_phase2';
  setScanV2Phase(
    resume ? 'resuming' : 'phase2_food_analysis',
    resume ? 'Phase 2 wird fortgesetzt…' : 'Phase 2: Food-Analyse wird vorbereitet…',
  );

  // Ein VOLLSTÄNDIGER Phase-2-Checkpoint (processedIndex >= alle Repräsentanten,
  // z. B. 1731/1731) hat keinerlei Modell-Arbeit mehr offen: Resume muss ihn nur
  // noch reassemblen/finalisieren. Dann KEIN Ollama-Preflight (Task P4 „keine
  // erneuten Ollama-Aufrufe") — sonst scheitert ein fertiger Lauf an einer
  // unnötigen Modell-Erreichbarkeitsprüfung, obwohl nichts mehr gesendet wird.
  const resumeComplete =
    !!resume && resume.processedIndex >= resume.representatives.length;

  // Phase 2 braucht ein echtes Modell — harter Preflight (anders als Phase 1).
  // Nur wenn tatsächlich noch Repräsentanten an das Modell gehen.
  if (!resumeComplete) {
    const pf = await ensureScanPreflight(true);
    if (!pf.ok) {
      throw new Error(`Phase 2 Preflight fehlgeschlagen: ${pf.error}`);
    }
  }
  throwIfScanV2Cancelled(controller);

  const model = resume?.model || resolveOllamaModel();
  const stamp = { now: new Date().toISOString(), model, version: PRODUCT_INTELLIGENCE_VERSION };

  // Plan: entweder frisch aus dem Snapshot gebaut, oder aus dem Checkpoint
  // wiederhergestellt (inkl. bereits analysierter Teilergebnisse).
  let representatives: Offer[];
  let followers: Offer[];
  let baseFood: Offer[]; // upToDate + locked + Phase-A-Reuse, inkl. REWE/nahkauf
  let skippedNonFood: Offer[];
  let imageById: Map<string, { imageStatus?: unknown; brokenImage?: unknown }>;
  let candidatesCount: number;
  let reusedFromBase: number;
  let skippedLockedCount: number;
  const analyzedFood: Offer[] = resume ? [...resume.analyzedFood] : [];
  const analyzedFiltered: Offer[] = resume ? [...resume.analyzedFiltered] : [];
  let aiClassifiedCount = resume ? resume.aiClassifiedCount : 0;
  let fallbackCount = resume ? resume.fallbackCount : 0;
  // Advisory pipeline warnings are rebuilt from the batches we still run; prior
  // ones are non-critical and need not survive a resume.
  const phase2Warnings: string[] = [];
  // Subquellen-/Prospekt-Diagnosen aus Phase 1 (Task P5): aus dem Resume-
  // Checkpoint, sonst aus dem zuletzt im Prozess gehaltenen Scrape. Sanitisiert,
  // damit Resume sie nicht still verliert.
  const phase2SubSourceDiagnostics = sanitizeSubSourceDiagnostics(
    resume?.subSourceDiagnostics ?? lastScrapeSubSourceDiagnostics,
  );
  let startIndex = 0;

  if (resume) {
    representatives = resume.representatives;
    followers = resume.followers;
    baseFood = resume.baseFood;
    skippedNonFood = resume.skippedNonFood;
    imageById = new Map(Object.entries(resume.imageById ?? {}));
    candidatesCount = resume.candidatesCount;
    reusedFromBase = resume.reusedFromBase;
    skippedLockedCount = resume.skippedLockedCount;
    startIndex = Math.max(0, Math.min(representatives.length, resume.processedIndex));
  } else {
    // Nur der live/current Food-Bucket wird analysiert; sicheres Non-Food
    // (filtered) bleibt unangetastet. REWE/nahkauf sind als Food enthalten und
    // landen über baseFood/Reuse wieder im Snapshot (manueller Import bleibt).
    // NextWeek läuft BEWUSST NICHT durch Phase 2 (keine KI-Kosten/Anreicherung
    // für die kommende Woche) — der Bucket bleibt als Phase-1-Bucket unverändert
    // erhalten und wird in der Reassembly als preservedNextWeek wieder angefügt.
    const foodInput = [...snapshot.offers];
    const partition = partitionFoodForAnalysis(foodInput);
    skippedNonFood = partition.skippedNonFood;

    // Phase-2-Kandidaten zusätzlich aus dem Filtered-Bucket: alle UNCERTAIN-
    // Angebote (zentrale classifyFoodDecision, NICHT das Modell-Flag) werden
    // erneut analysiert, damit Phase 2 frühe Phase-1-Fehler korrigieren kann.
    // Regelbestätigtes Non-Food, Fragmente, Sektionsüberschriften und gesperrte/
    // manuell entschiedene Angebote werden NIE an das Modell gesendet.
    const uncertainFiltered = selectUncertainFilteredForPhase2(snapshot.filteredOffers);

    // Phase-1 Bild-Verdikte sichern, damit der Python-Pass sie nicht verwirft.
    imageById = new Map<string, { imageStatus?: unknown; brokenImage?: unknown }>();
    for (const offer of foodInput) {
      const so = offer as ScanV2Offer;
      if (so.imageStatus !== undefined || so.brokenImage !== undefined) {
        imageById.set(offer.id, { imageStatus: so.imageStatus, brokenImage: so.brokenImage });
      }
    }

    // selectAiCandidates trennt locked (nie gesendet/nie überschrieben) + aktuell.
    // Sichtbares Food + uncertain-filtered teilen sich dieselbe Kandidaten-Pipeline.
    const selection = selectAiCandidates([...partition.food, ...uncertainFiltered.candidates]);
    const donors = [...selection.upToDate, ...selection.locked];
    const existingIndex = buildProductAnalysisIndex(donors);
    const phaseA = reuseProductAnalysis(selection.candidates, existingIndex, stamp);
    const dedup = dedupeByProductKey(phaseA.stillNeedAi);
    representatives = dedup.representatives;
    followers = dedup.followers;
    baseFood = [...selection.upToDate, ...selection.locked, ...phaseA.reused];
    candidatesCount = selection.candidates.length;
    reusedFromBase = phaseA.reused.length;
    skippedLockedCount = selection.locked.length;
  }

  // NextWeek wird in Phase 2 bewusst übersprungen (keine KI-Kosten/Anreicherung).
  // Der Bucket ist unverändert im Snapshot vorhanden; hier nur zählen + ehrlich
  // ausweisen, wie viele Angebote gezielt nicht verarbeitet wurden.
  const skippedNextWeekCount = snapshot.nextWeekOffers.length;

  scanV2State.total = representatives.length;
  scanV2State.processed = startIndex;
  scanV2State.phase2.candidatesCount = candidatesCount;
  scanV2State.phase2.sentToModel = representatives.length;
  scanV2State.phase2.reusedProductAnalysis = reusedFromBase;
  scanV2State.phase2.skippedNonFoodCount = skippedNonFood.length;
  scanV2State.phase2.skippedLockedCount = skippedLockedCount;
  scanV2State.phase2.skippedNextWeekCount = skippedNextWeekCount;
  setScanV2Phase(
    'phase2_food_analysis',
    `Phase 2: ${candidatesCount} Kandidaten · ${representatives.length} an Modell · ` +
      `${reusedFromBase} aus Produkt-Cache · ${skippedLockedCount} gesperrt · ` +
      `NextWeek übersprungen: ${skippedNextWeekCount}.`,
  );

  const persist = async (processedIndex: number): Promise<void> => {
    scanV2State.processed = processedIndex;
    await persistScanV2Checkpoint(
      buildScanV2Checkpoint({
        mode,
        phase: 'phase2_food_analysis',
        startedAt: startedAtIso,
        total: representatives.length,
        processed: processedIndex,
        phase2: {
          representatives,
          followers,
          baseFood,
          skippedNonFood,
          imageById: Object.fromEntries(imageById),
          processedIndex,
          analyzedFood,
          analyzedFiltered,
          candidatesCount,
          reusedFromBase,
          skippedLockedCount,
          aiClassifiedCount,
          fallbackCount,
          model,
          subSourceDiagnostics: phase2SubSourceDiagnostics,
        },
        diagnostics: { phase2Warnings },
      }),
    );
  };

  // Plan up-front sichern, damit auch ein Pause im ersten Batch resumebar ist.
  await persist(startIndex);

  // Modell-Lauf in kleinen Batches: bereits analysierte Repräsentanten (Index <
  // startIndex) werden NICHT erneut an Qwen geschickt.
  await runCategorizerBatches({
    items: representatives,
    startIndex,
    batchSize: scanV2Phase2BatchSize(),
    controller,
    runBatch: (batch, baseIndex) =>
      runOffersCategorizerPipeline(batch, {
        tryOllama: true,
        mode: appConfig.offerWeekMode,
        engine: 'aichef_offers',
        ollamaTimeoutMs: appConfig.aiRescanOllamaTimeoutMs,
        ollamaRetries: appConfig.aiRescanOllamaRetries,
        model,
        signal: controller.signal,
        onProgress: (progress) => {
          scanV2State.total = representatives.length;
          scanV2State.processed = baseIndex + progress.processed;
          setScanV2Phase(
            'phase2_food_analysis',
            `Phase 2 Food-Analyse: ${scanV2State.processed}/${representatives.length}`,
          );
        },
      }),
    onBatchDone: async (newIndex, result) => {
      for (const offer of result.offers) analyzedFood.push(stampAnalysisMeta(offer, stamp));
      for (const offer of result.filteredOffers) analyzedFiltered.push(stampAnalysisMeta(offer, stamp));
      aiClassifiedCount += result.aiClassifiedCount;
      fallbackCount += result.fallbackCount;
      phase2Warnings.push(...result.warnings);
      await persist(newIndex);
    },
  });
  throwIfScanV2Cancelled(controller);

  // ── Finalize Phase 2 (unverändert; aus akkumulierten Ergebnissen gespeist) ──
  // Frische Analysen auf Follower (gleicher Produkt-Key) übertragen.
  const repIndex = new Map<string, Offer>();
  for (const rep of [...analyzedFood, ...analyzedFiltered]) {
    const key = productKeyForOffer(rep);
    if (!repIndex.has(key)) repIndex.set(key, rep);
  }
  const phaseB = reuseProductAnalysis(followers, repIndex, stamp);

  // Gesamtes Food-Universum kombinieren (nie ein Angebot verlieren). baseFood
  // enthält die preserved REWE/nahkauf manuellen Importe → bleiben erhalten.
  const combinedFood: Offer[] = [
    ...baseFood,
    ...analyzedFood,
    ...analyzedFiltered,
    ...phaseB.reused,
    ...phaseB.stillNeedAi,
  ];

  // Phase-1 Bild-Verdikte wiederherstellen, die der Python-Pass evtl. verworfen hat.
  const restored: Offer[] = combinedFood.map((offer) => {
    const img = imageById.get(offer.id);
    if (!img) return offer;
    return { ...(offer as ScanV2Offer), imageStatus: img.imageStatus, brokenImage: img.brokenImage } as Offer;
  });

  // Reine Phase-2-Reassembly (Task P2, extrahiert nach phase2Reassembly.ts):
  // restored → Food/Non-Food → current/next (zeitlich gültig) → Fragment-
  // Quarantäne → alter Filter ohne reanalysierte ids → finaler Non-Food-Gate.
  const excludedStores = parseExcludedStores(appConfig.weeklyScanExcludedStores);
  const reassembly = reassemblePhase2Buckets({
    restored,
    previousFiltered: snapshot.filteredOffers,
    skippedNonFood,
    // NextWeek lief NICHT durch Phase 2 → unverändert (deep-equal) wieder anfügen.
    preservedNextWeek: snapshot.nextWeekOffers,
    now: new Date(),
    weekBucketOf: (offer) => classifyOfferWeek(offer),
    isPreserved: (offer) => isStoreExcluded(offer.storeChain, excludedStores),
    maxValidityDays: appConfig.offerMaxValidityDays,
  });
  const nonFoodGate = {
    offers: reassembly.offers,
    nextWeekOffers: reassembly.nextWeekOffers,
    filteredOffers: reassembly.filteredOffers,
  };
  const phase2RecoveredFoodCount = reassembly.phase2RecoveredFoodCount;
  const phase2ConfirmedNonFoodCount = reassembly.phase2ConfirmedNonFoodCount;
  if (reassembly.quarantinedFragmentNames.length > 0) {
    phase2Warnings.push(
      `${reassembly.quarantinedFragmentNames.length} Fragment-Angebot(e) in Review-Quarantäne verschoben (nie live): ${reassembly.quarantinedFragmentNames
        .slice(0, 6)
        .join(', ')}.`,
    );
  }
  if (reassembly.nonFoodGateMovedCount > 0) {
    phase2Warnings.push(
      `Non-Food-Gate: ${reassembly.nonFoodGateMovedCount} Angebot(e) mit klarem Non-Food-Signal aus Live/Naechste-Woche nach Filtered verschoben (z. B. ${reassembly.nonFoodGateMovedExamples
        .slice(0, 4)
        .join(', ')}).`,
    );
  }
  if (phase2RecoveredFoodCount + phase2ConfirmedNonFoodCount > 0) {
    phase2Warnings.push(
      `Phase-2-Recheck: ${phase2RecoveredFoodCount} uncertain-Angebot(e) aus dem Filter als Food gerettet, ` +
        `${phase2ConfirmedNonFoodCount} als Non-Food bestätigt (bleiben gefiltert).`,
    );
  }
  // Safety-Gate (Datenqualität #5) vor dem Schreiben.
  lastSubSourceOutcomes = assertSnapshotSafeToCommit(
    { offers: snapshot.offers, nextWeekOffers: snapshot.nextWeekOffers, filteredOffers: snapshot.filteredOffers },
    { offers: nonFoodGate.offers, nextWeekOffers: nonFoodGate.nextWeekOffers, filteredOffers: nonFoodGate.filteredOffers },
    'phase2',
    [...snapshot.warnings, ...phase2Warnings],
    phase2SubSourceDiagnostics,
  );
  // Transienten Phase-2-Recheck-Tag vor dem Persistieren entfernen.
  snapshot.offers = nonFoodGate.offers.map(stripPhase2RecheckTag);
  snapshot.nextWeekOffers = nonFoodGate.nextWeekOffers.map(stripPhase2RecheckTag);
  snapshot.filteredOffers = nonFoodGate.filteredOffers.map(stripPhase2RecheckTag);
  snapshot.updatedAt = new Date().toISOString();
  snapshot.warnings = sanitizeWarnings([
    ...snapshot.warnings,
    ...phase2Warnings,
    `Angebots-Scan 2.0 Phase 2: ${candidatesCount} Kandidaten analysiert · ` +
      `${representatives.length} an Modell · ${reusedFromBase + phaseB.reused.length} aus Cache · ` +
      `${skippedLockedCount} gesperrt (unverändert) · NextWeek übersprungen: ${skippedNextWeekCount}.`,
  ]);
  await saveSnapshot({ enforceFoodReconciliation: true, scope: scanV2State.scope ?? allStoresScope() });

  scanV2State.phase2 = {
    candidatesCount,
    sentToModel: representatives.length,
    aiClassifiedCount,
    reusedProductAnalysis: reusedFromBase + phaseB.reused.length,
    fallbackCount,
    reviewNeededCount: countUncertain(restored),
    skippedNonFoodCount: skippedNonFood.length,
    skippedLockedCount,
    skippedNextWeekCount,
    uncertainFilteredCandidatesCount: restored.filter(isPhase2Recheck).length,
    phase2RecoveredFoodCount,
    phase2ConfirmedNonFoodCount,
    durationMs: Date.now() - startedMs,
  };

  appendBackendDebugLog('info', 'offers.scanV2.phase2.completed', {
    candidatesCount,
    sentToModel: representatives.length,
    aiClassifiedCount: scanV2State.phase2.aiClassifiedCount,
    reusedProductAnalysis: scanV2State.phase2.reusedProductAnalysis,
    skippedNonFoodCount: skippedNonFood.length,
    skippedLockedCount,
    skippedNextWeekCount,
    durationMs: scanV2State.phase2.durationMs,
    resumed: Boolean(resume),
  });

  // Cheffity Auto-Sync: Phase 2 is committed → single sync point for both
  // phase2-only and phase1_phase2 (Phase 1 deliberately skipped syncing). The
  // safety/quality gate throws above (snapshot uncommitted) and never reaches
  // this hook. Fail-soft: a sync error keeps the scan successful.
  if (shouldSyncAfterPhase2Commit(mode)) {
    await runCheffitySyncForCurrentSnapshot('scan_v2_phase2', { scanType: 'scan_v2_phase2' });
  }

}

async function runScanV2Flow(
  mode: ScanV2Mode,
  forceAll: boolean,
  resume?: ScanV2Checkpoint,
): Promise<void> {
  const startedMs = Date.now();
  const fresh = createInitialScanV2Status();
  fresh.mode = mode;
  fresh.running = true;
  // On resume keep the ORIGINAL start time + prior progress so "pausiert seit" /
  // processed counts stay meaningful across the restart.
  fresh.startedAt = resume?.startedAt ?? new Date().toISOString();
  fresh.phase = resume ? 'resuming' : 'idle';
  fresh.total = resume?.total ?? 0;
  fresh.processed = resume?.processed ?? 0;
  fresh.checkpointAvailable = Boolean(resume);
  fresh.message = resume
    ? `Angebots-Scan 2.0 (${mode}) wird fortgesetzt…`
    : `Angebots-Scan 2.0 (${mode}) gestartet.`;
  Object.assign(scanV2State, fresh);
  scanV2PauseRequested = false;

  // Gemeinsamer „heavy job läuft"-Guard mit 1.0/Refresh/Wochen-Auto-Scan.
  ingestState.running = true;
  ingestState.startedAt = new Date().toISOString();
  ingestState.finishedAt = null;
  ingestState.lastError = null;
  ingestState.message = `Angebots-Scan 2.0 (${mode}) laeuft…`;

  const controller = new AbortController();
  scanV2AbortController = controller;

  appendBackendDebugLog('info', 'offers.scanV2.started', { mode, forceAll, resumed: Boolean(resume) });

  let outcome: 'done' | 'paused' | 'cancelled' | 'error' = 'done';
  try {
    // SCOPE bestimmen — der aktive Shop-Scope dieses Laufs (steuert das Gate):
    //  • Resume → exakt derselbe Scope wie vor der Pause (alte Checkpoints werden
    //    defensiv migriert; unklare brechen kontrolliert ab).
    //  • Full-Scrape-Lauf (Phase 1 enthalten) → all_stores (alle Pflicht-Shops).
    //  • Phase-2-only → Scope aus dem TATSÄCHLICHEN Snapshot ableiten (z. B. nur
    //    REWE), nicht aus der globalen Konfiguration.
    let scope: ScanV2Scope;
    if (resume) {
      const resolved = resolveCheckpointScope(resume);
      if ('error' in resolved) throw new Error(resolved.error);
      scope = resolved;
    } else if (modeIncludesPhase1(mode)) {
      scope = allStoresScope();
    } else {
      scope = deriveScopeFromOffers([
        ...snapshot.offers,
        ...snapshot.nextWeekOffers,
        ...snapshot.filteredOffers,
      ]);
    }
    scanV2State.scope = scope;
    appendBackendDebugLog('info', 'offers.scanV2.scopeResolved', {
      mode, resumed: Boolean(resume), scope: describeScope(scope),
    });

    if (resume) {
      // Resume routing: continue exactly where the checkpoint left off.
      if (resume.phase2) {
        await runScanV2Phase2(controller, resume.phase2);
      } else if (resume.phase1) {
        await runScanV2Phase1(controller, resume.phase1);
        throwIfScanV2Cancelled(controller);
        if (modeIncludesPhase2(mode)) await runScanV2Phase2(controller);
      } else if (resume.phase === 'phase1_done') {
        // Phase 1 was already committed to the snapshot → run Phase 2 fresh.
        if (modeIncludesPhase2(mode)) await runScanV2Phase2(controller);
      } else {
        throw new Error('Checkpoint enthält keinen fortsetzbaren Abschnitt.');
      }
    } else {
      if (modeIncludesPhase1(mode)) {
        await runScanV2Phase1(controller);
      }
      throwIfScanV2Cancelled(controller);
      if (modeIncludesPhase2(mode)) {
        await runScanV2Phase2(controller);
      }
    }

    outcome = 'done';
    scanV2State.running = false;
    scanV2State.paused = false;
    scanV2State.phase = 'done';
    scanV2State.finishedAt = new Date().toISOString();
    scanV2State.durationMs = Date.now() - startedMs;
    scanV2State.message =
      `Angebots-Scan 2.0 (${mode}) fertig: ${snapshot.offers.length} Live, ` +
      `${snapshot.nextWeekOffers.length} Naechste-Woche, ${snapshot.filteredOffers.length} gefiltert.`;
    ingestState.running = false;
    ingestState.finishedAt = new Date().toISOString();
    ingestState.message = scanV2State.message;

    appendBackendDebugLog('info', 'offers.scanV2.completed', {
      mode,
      liveCount: snapshot.offers.length,
      nextWeekCount: snapshot.nextWeekOffers.length,
      filteredCount: snapshot.filteredOffers.length,
      durationMs: scanV2State.durationMs,
    });
  } catch (error) {
    // Pause unwinds via ScanV2PausedError, or via a PipelineCancelledError that
    // the abort raised while a pause was pending — both keep the checkpoint.
    const paused =
      error instanceof ScanV2PausedError ||
      (error instanceof PipelineCancelledError && scanV2PauseRequested);
    const cancelled = !paused && error instanceof PipelineCancelledError;
    outcome = paused ? 'paused' : cancelled ? 'cancelled' : 'error';

    if (paused) {
      // Align the displayed counts to the actual resumable checkpoint (the live
      // counter may be a few items ahead from the interrupted in-flight batch).
      if (scanV2CheckpointMeta) {
        scanV2State.processed = scanV2CheckpointMeta.processed;
        scanV2State.total = scanV2CheckpointMeta.total;
      }
      const message = `${summarizePausedMessage(scanV2State)} — Checkpoint gespeichert, /resume möglich.`;
      scanV2State.running = false;
      scanV2State.paused = true;
      scanV2State.phase = 'paused';
      scanV2State.pausedAt = new Date().toISOString();
      scanV2State.durationMs = Date.now() - startedMs;
      scanV2State.lastError = null;
      scanV2State.message = message;
      // The heavy-job slot is freed so other scans can run again.
      ingestState.running = false;
      ingestState.finishedAt = new Date().toISOString();
      ingestState.lastError = null;
      ingestState.message = message;
      appendBackendDebugLog('info', 'offers.scanV2.paused', {
        mode, processed: scanV2State.processed, total: scanV2State.total,
      });
    } else {
      const qualityFailed = error instanceof ScanQualityGateError;
      const message = cancelled
        ? 'Angebots-Scan 2.0 vom Nutzer abgebrochen.'
        : error instanceof Error
          ? error.message
          : 'Unbekannter Angebots-Scan-2.0-Fehler';
      scanV2State.running = false;
      scanV2State.paused = false;
      scanV2State.phase = cancelled ? 'cancelled' : 'error';
      scanV2State.finishedAt = new Date().toISOString();
      scanV2State.durationMs = Date.now() - startedMs;
      scanV2State.lastError = message;
      scanV2State.message = message;
      // Strukturierten Qualitäts-Gate-Fehler mit Check-ID(s) + begrenzten
      // Beispielen im Status ausweisen (Task P1/P4) — sonst null lassen.
      scanV2State.qualityFailure =
        error instanceof ScanQualityGateError
          ? ({
              failedChecks: error.failedChecks,
              reasons: error.reasons,
              examples: error.examples.slice(0, 8),
            } satisfies ScanV2QualityFailure)
          : null;
      ingestState.running = false;
      ingestState.finishedAt = new Date().toISOString();
      ingestState.lastError = message;
      ingestState.message = cancelled
        ? message
        : qualityFailed
          ? `Angebots-Scan 2.0 Qualitäts-Gate fehlgeschlagen — alter Snapshot behalten. ${message}`
          : 'Angebots-Scan 2.0 fehlgeschlagen.';
      // Cancel/Fehler in Phase 2 lassen die in Phase 1 gespeicherten Daten intakt.
      appendBackendDebugLog(cancelled ? 'info' : 'error', 'offers.scanV2.failed', {
        mode,
        cancelled,
        qualityFailed,
        failedChecks: error instanceof ScanQualityGateError ? error.failedChecks : undefined,
        error: message,
      });
    }
  } finally {
    scanV2AbortController = null;
    scanV2PauseRequested = false;
    // Disposition: pause/error KEEP the checkpoint (resumable); done/cancel CLEAR it.
    if (checkpointDisposition(outcome) === 'clear') {
      await discardScanV2Checkpoint().catch(() => undefined);
    }
  }
}

function startScanV2Background(mode: ScanV2Mode, forceAll: boolean, resume?: ScanV2Checkpoint): void {
  const fresh = createInitialScanV2Status();
  fresh.mode = mode;
  fresh.running = true;
  fresh.startedAt = resume?.startedAt ?? new Date().toISOString();
  fresh.phase = resume ? 'resuming' : 'idle';
  fresh.checkpointAvailable = Boolean(resume);
  fresh.message = resume
    ? `Angebots-Scan 2.0 (${mode}) wird fortgesetzt…`
    : `Angebots-Scan 2.0 (${mode}) wird initialisiert…`;
  Object.assign(scanV2State, fresh);

  scanV2BackgroundTask = (async () => {
    try {
      await runScanV2Flow(mode, forceAll, resume);
    } catch {
      // Fehler sind bereits in scanV2State protokolliert.
    } finally {
      scanV2BackgroundTask = null;
    }
  })();
}

/**
 * Nach einem erfolgreichen manuellen REWE-Import (Browser/Screenshot/PDF) die
 * Phase-2-Food-Analyse anstoßen, damit importierte Angebote dieselbe
 * Kategorisierung/Enrichment durchlaufen wie gescannte (weniger "Sonstiges").
 * Best-effort: läuft nur, wenn kein anderer Scan/Checkpoint aktiv ist und
 * Ollama erreichbar ist — sonst wird eine ehrliche Warnung zurückgegeben, die
 * der Aufrufer in die Snapshot-Warnings übernimmt.
 */
async function maybeStartPhase2AfterReweImport(
  source: string,
  label = 'REWE-Import',
): Promise<string | null> {
  const pendingWarning =
    `Hinweis: ${label} wartet auf Phase-2-Analyse (Angebots-Scan 2.0 Phase 2 starten), ` +
    'damit Kategorien/Nährwerte angereichert werden.';
  const allowed = canStartScanV2();
  if (!allowed.ok || scanV2CheckpointMeta) {
    appendBackendDebugLog('info', 'offers.reweImport.phase2Deferred', {
      source,
      reason: allowed.ok ? 'checkpoint vorhanden' : allowed.error,
    });
    return pendingWarning;
  }
  const ollamaUp = await isOllamaReachable(resolveOllamaHost()).catch(() => false);
  if (!ollamaUp) {
    appendBackendDebugLog('info', 'offers.reweImport.phase2Deferred', {
      source,
      reason: 'Ollama nicht erreichbar',
    });
    return pendingWarning;
  }
  startScanV2Background('phase2', false);
  appendBackendDebugLog('info', 'offers.reweImport.phase2Started', { source });
  return null;
}

app.use((request, response, next) => {
  // Bookmarklets on public HTTPS sites (e.g. www.lidl.de) call the local backend
  // on 127.0.0.1. Chromium's Private Network Access preflight requires this
  // explicit opt-in in addition to normal CORS, otherwise fetch() fails before
  // the request reaches the endpoint.
  if (request.headers['access-control-request-private-network'] === 'true') {
    response.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  next();
});
app.use(cors());
// PDF/Screenshot-Imports kommen als base64-DataURL im JSON-Body. Base64 bläht
// die Bytes um ~33% auf, also passt ein ~225 MB PDF gerade noch in 300 MB.
// Vorher 100 MB → REWE-PDFs >75 MB raw scheiterten mit PayloadTooLargeError,
// was der globale Handler unten als 500 "Interner Serverfehler" zurückgab.
// Siehe auch error handler am Datei-Ende (PayloadTooLargeError → 413).
app.use(express.json({ limit: '300mb' }));

app.use((request, response, next) => {
  const startedAt = Date.now();
  appendBackendDebugLog('debug', 'http.request', {
    method: request.method,
    path: request.path,
  });

  response.on('finish', () => {
    appendBackendDebugLog('debug', 'http.response', {
      method: request.method,
      path: request.path,
      statusCode: response.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });

  next();
});

app.get('/', (_request, response) => {
  response.type('html').send(renderDashboardHtml(frontendUrl));
});

// /admin-v2 — Backend Admin Control Center.
//
// SECURITY: dieser Endpoint hat aktuell KEINE Auth. Das ist okay solange
// das Backend nur lokal auf 127.0.0.1:8787 läuft — das ist seit dem
// BIND_HOST-Fix (siehe `bindHost` oben) tatsächlich der Default. Vorher
// band `app.listen(port)` ohne Host-Argument an 0.0.0.0, wodurch dieser
// Kommentar eine Annahme beschrieb, die der Code nicht einlöste.
//
// ACHTUNG: Mit BIND_HOST=0.0.0.0 (LAN-Handytests) ist /admin-v2 wieder für
// jeden im Netz offen. Bevor das Backend remote erreichbar wird, MUSS einer
// der drei Schutzmechanismen aus docs/admin-v2-release-checklist.md aktiv sein:
//   - kurzfristig: Reverse-Proxy mit Basic-Auth oder VPN-only
//   - mittelfristig: Supabase JWT + public.is_admin()-Check als Middleware
//   - langfristig: separates Admin-Panel mit echter Auth (admin/-Projekt)
app.get('/admin-v2', (_request, response) => {
  response
    .set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    .set('Pragma', 'no-cache')
    .set('Expires', '0')
    .type('html')
    .send(renderAdminDashboardHtml(frontendUrl));
});

app.get('/rewe-browser-import', (_request, response) => {
  response.type('html').send(renderReweBrowserImportHtml());
});

app.get('/api/health', (_request, response) => {
  appendBackendDebugLog('info', 'health.check');
  response.json({
    ok: true,
    service: 'aichef-offers-backend',
    time: new Date().toISOString(),
  });
});

app.post('/api/cheffity/generate-recipes', async (request, response) => {
  if (!isRecipeGenerationConfigured()) {
    response.status(503).json({
      error: 'Recipe generation nicht konfiguriert. SUPABASE_URL und SUPABASE_SERVICE_ROLE_KEY in .env eintragen.',
    });
    return;
  }
  const rawCount = Number((request.body as { count?: unknown })?.count ?? 5);
  const count = Number.isFinite(rawCount) ? Math.max(1, Math.min(30, Math.round(rawCount))) : 5;

  appendBackendDebugLog('info', 'cheffity.generateRecipes.start', { count });
  try {
    const result = await generateRecipes(count);
    appendBackendDebugLog('info', 'cheffity.generateRecipes.completed', {
      attempted: result.attempted,
      generated: result.generated,
      failed: result.failed,
      errorsCount: result.errors.length,
      durationMs: result.durationMs,
    });
    response.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unbekannter Generation-Fehler';
    appendBackendDebugLog('error', 'cheffity.generateRecipes.failed', { error: message });
    response.status(500).json({ error: message });
  }
});

app.post('/api/offers/sync-supabase', async (_request, response) => {
  if (!isSupabaseSyncConfigured()) {
    response.status(503).json({
      error: 'Supabase-Sync nicht konfiguriert. SUPABASE_URL und SUPABASE_SERVICE_ROLE_KEY in .env eintragen.',
    });
    return;
  }
  appendBackendDebugLog('info', 'offers.supabaseSync.manualStart', {
    offersCount: snapshot.offers.length,
    nextWeekCount: snapshot.nextWeekOffers.length,
  });
  try {
    const combinedOffers = [...snapshot.offers, ...snapshot.nextWeekOffers];
    const result = await syncDealsToSupabase(
      combinedOffers,
      snapshot.offerScopes,
      {
        nextWeekOfferIds: new Set(snapshot.nextWeekOffers.map((offer) => offer.id)),
        disabledStores: parseDisabledStores(appConfig.offersDisabledStores),
      },
    );
    appendBackendDebugLog('info', 'offers.supabaseSync.manualCompleted', {
      attempted: result.attempted,
      upserted: result.upserted,
      skipped: result.skipped,
      staleExpired: result.staleExpired,
      staleByStore: result.staleByStore,
      staleExpireErrors: result.staleExpireErrors.length,
      collisions: result.collisions,
      currentBucketForcedTodayCount: result.currentBucketForcedTodayCount,
      futureBucketForcedTomorrowCount: result.futureBucketForcedTomorrowCount,
      errorsCount: result.errors.length,
      durationMs: result.durationMs,
    });
    // Same snapshot → offer_history. Errors are surfaced but do not flip
    // the manual sync to "failed" — history is best-effort.
    const historyResult = await writeOfferHistory(
      combinedOffers as Array<typeof combinedOffers[number] & Record<string, unknown>>,
      { scanType: 'manual_sync' },
    );
    appendBackendDebugLog('info', 'offers.offerHistory.manualCompleted', {
      snapshotId: historyResult.snapshotId,
      scanRunId: historyResult.scanRunId,
      attempted: historyResult.attempted,
      written: historyResult.written,
      expired: historyResult.expired,
      errors: historyResult.errors.length,
      durationMs: historyResult.durationMs,
    });
    lastSupabaseSyncState.at = new Date().toISOString();
    lastSupabaseSyncState.status = result.errors.length === 0 ? 'ok' : 'error';
    lastSupabaseSyncState.upserted = result.upserted;
    lastSupabaseSyncState.errors = result.errors.length;
    // Rebuild deal⇄recipe-ingredient matches off the freshly-synced deals and
    // surface a compact summary in the response.
    const recipeMatch = await runDealRecipeMatchSafe('manual_sync');
    response.json({
      ok: true,
      ...result,
      history: historyResult,
      recipeMatch: recipeMatch
        ? {
            candidateMatches: recipeMatch.candidateMatches,
            writtenMatches: recipeMatch.writtenMatches,
            recipesWithMatches: recipeMatch.recipesWithMatches,
            deletedExpiredMatches: recipeMatch.deletedExpiredMatches,
            errors: recipeMatch.errors.length,
            durationMs: recipeMatch.durationMs,
          }
        : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unbekannter Sync-Fehler';
    appendBackendDebugLog('error', 'offers.supabaseSync.manualFailed', { error: message });
    lastSupabaseSyncState.at = new Date().toISOString();
    lastSupabaseSyncState.status = 'error';
    lastSupabaseSyncState.errors = (lastSupabaseSyncState.errors ?? 0) + 1;
    response.status(500).json({ error: message });
  }
});

// Rebuild deal⇄recipe-ingredient matches on demand. Local/admin-context only —
// mirrors the other Supabase admin endpoints (no separate auth in the backend).
// Body: { dryRun?: boolean } — dryRun=true reports candidates without writing.
app.post('/api/cheffity/match-deals', async (request, response) => {
  if (!isDealMatcherConfigured()) {
    response.status(503).json({
      error: 'Deal-Matcher nicht konfiguriert. SUPABASE_URL und SUPABASE_SERVICE_ROLE_KEY in .env eintragen.',
    });
    return;
  }
  const dryRun = (request.body as { dryRun?: unknown } | undefined)?.dryRun === true;
  appendBackendDebugLog('info', 'cheffity.dealMatch.manualStart', { dryRun });
  try {
    const result = await runDealRecipeMatch({ dryRun });
    recordRecipeMatchState(result); // no-op for dryRun
    appendBackendDebugLog('info', 'cheffity.dealMatch.manualCompleted', {
      dryRun,
      candidateMatches: result.candidateMatches,
      writtenMatches: result.writtenMatches,
      recipesWithMatches: result.recipesWithMatches,
      errorsCount: result.errors.length,
      durationMs: result.durationMs,
    });
    response.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unbekannter Match-Fehler';
    appendBackendDebugLog('error', 'cheffity.dealMatch.manualFailed', { error: message });
    response.status(500).json({ error: message });
  }
});

// Quality report for the deals⇄recipes connection. Diagnostic only, read-only.
// Fail-soft: never 500s the admin UI — a missing config or failed query returns
// zero KPIs + a warning so the dashboard stays alive.
app.get('/api/cheffity/offer-quality', async (_request, response) => {
  const generatedAt = new Date().toISOString();
  const supabaseConfigured = isOfferQualityConfigured();
  const lastSupabaseSync = {
    at: lastSupabaseSyncState.at,
    status: lastSupabaseSyncState.at ? lastSupabaseSyncState.status : 'never',
    upserted: lastSupabaseSyncState.upserted ?? 0,
    errors: lastSupabaseSyncState.errors ?? 0,
  };
  const lastRecipeMatch = {
    at: lastRecipeMatchState.at,
    status: lastRecipeMatchState.at ? lastRecipeMatchState.status : 'never',
    candidateMatches: lastRecipeMatchState.candidateMatches ?? 0,
    writtenMatches: lastRecipeMatchState.writtenMatches ?? 0,
    recipesWithMatches: lastRecipeMatchState.recipesWithMatches ?? 0,
    errors: lastRecipeMatchState.errors ?? 0,
  };

  if (!supabaseConfigured) {
    const empty = emptyOfferQualityReport();
    response.json({
      ok: true,
      generatedAt,
      supabaseConfigured: false,
      lastSupabaseSync,
      lastRecipeMatch,
      kpis: empty.kpis,
      topUnmatchedDeals: empty.topUnmatchedDeals,
      topUnmatchedIngredients: empty.topUnmatchedIngredients,
      reviewCandidates: empty.reviewCandidates,
      suspiciousMatches: empty.suspiciousMatches,
      warnings: ['Supabase nicht konfiguriert — SUPABASE_URL und SUPABASE_SERVICE_ROLE_KEY in .env eintragen.'],
    });
    return;
  }

  try {
    const report = (await runCheffityOfferQuality()) ?? emptyOfferQualityReport();
    appendBackendDebugLog('info', 'cheffity.offerQuality.read', {
      activeDeals: report.kpis.activeDeals,
      matchableDeals: report.kpis.matchableDeals,
      validDealMatches: report.kpis.validDealMatches,
      highConfidenceMatches: report.kpis.highConfidenceMatches,
      reviewMatches: report.kpis.reviewMatches,
      suspiciousMatches: report.kpis.suspiciousMatches,
      recipeCoveragePercent: report.kpis.recipeCoveragePercent,
      warnings: report.warnings.length,
    });
    response.json({
      ok: true,
      generatedAt,
      supabaseConfigured: true,
      lastSupabaseSync,
      lastRecipeMatch,
      kpis: report.kpis,
      topUnmatchedDeals: report.topUnmatchedDeals,
      topUnmatchedIngredients: report.topUnmatchedIngredients,
      reviewCandidates: report.reviewCandidates,
      suspiciousMatches: report.suspiciousMatches,
      warnings: report.warnings,
    });
  } catch (error) {
    // Fail-soft: surface the error as a warning, keep the dashboard alive.
    const message = error instanceof Error ? error.message : 'Unbekannter Quality-Fehler';
    appendBackendDebugLog('error', 'cheffity.offerQuality.failed', { error: message });
    const empty = emptyOfferQualityReport();
    response.json({
      ok: true,
      generatedAt,
      supabaseConfigured: true,
      lastSupabaseSync,
      lastRecipeMatch,
      kpis: empty.kpis,
      topUnmatchedDeals: empty.topUnmatchedDeals,
      topUnmatchedIngredients: empty.topUnmatchedIngredients,
      reviewCandidates: empty.reviewCandidates,
      suspiciousMatches: empty.suspiciousMatches,
      warnings: [`Abfrage fehlgeschlagen: ${message}`],
    });
  }
});

app.get('/api/offers/rewe-browser-import/bookmarklet.js', (_request, response) => {
  response
    .type('application/javascript')
    .send(createReweBrowserImportBookmarkletScript());
});

app.post('/api/offers/rewe-browser-import/open', (_request, response) => {
  const reweUrl = 'https://www.rewe.de/angebote/nationale-angebote/';
  try {
    openExternalUrl(reweUrl);
    appendBackendDebugLog('info', 'offers.reweBrowserImport.opened', { reweUrl });
    response.json({ ok: true, url: reweUrl });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'REWE konnte nicht geoeffnet werden.';
    appendBackendDebugLog('error', 'offers.reweBrowserImport.openFailed', { message });
    response.status(500).json({ error: message });
  }
});

app.post('/api/offers/rewe-browser-import', async (request, response) => {
  if (ingestState.running) {
    response.status(409).json({
      error: 'REWE Browser-Import nicht moeglich waehrend ein Refresh laeuft.',
      ingest: ingestState,
    });
    return;
  }

  const validation = reweBrowserImportRequestSchema.safeParse(request.body ?? {});
  if (!validation.success) {
    const details = validation.error.flatten();
    appendBackendDebugLog('warn', 'offers.reweBrowserImport.invalid', {
      fieldErrors: details.fieldErrors,
      formErrors: details.formErrors,
      receivedKeys: Object.keys((request.body as Record<string, unknown>) ?? {}),
    });
    response.status(400).json({
      error: 'Ungueltiger REWE Browser-Import.',
      details,
    });
    return;
  }

  const normalized = normalizeReweBrowserImportRequest(validation.data);
  lastReweImportReport = normalized.report;
  lastReweImportMethod = 'browser';
  if (normalized.offers.length === 0) {
    response.status(400).json({
      error: 'Keine gueltigen REWE-Angebote im Browser-Import gefunden.',
      skippedCount: normalized.skippedCount,
      report: normalized.report,
    });
    return;
  }

  // Hartes Qualitäts-Gate: Fragmente im Live-Feed, kaputte Preiszuordnung oder
  // ein in der Quelle vorhandenes, aber nicht geparstes bekanntes Angebot
  // verhindern den Snapshot-Commit — der Import wird ehrlich abgelehnt.
  const browserQuality = assessReweImportQuality(normalized.report);
  if (browserQuality.blockCommit) {
    appendBackendDebugLog('warn', 'offers.reweBrowserImport.qualityRejected', {
      reasons: browserQuality.reasons,
      normalizedCount: normalized.report.normalizedCount,
    });
    response.status(422).json({
      error: `REWE Browser-Import abgelehnt (Qualitäts-Gate): ${browserQuality.reasons.join(' ')}`,
      report: normalized.report,
      quality: browserQuality,
    });
    return;
  }

  const knownIds = new Set([
    ...snapshot.offers.map((offer) => offer.id),
    ...snapshot.nextWeekOffers.map((offer) => offer.id),
    ...snapshot.filteredOffers.map((offer) => offer.id),
  ]);
  // Compute the new REWE feed FIRST (no snapshot mutation yet) so a failure
  // before this point leaves the previous snapshot fully intact.
  const strictFilterResult = filterOffersStrictFood(normalized.offers);
  const weekSplit = splitOffersByWeek(strictFilterResult.offers);

  // P1 — ATOMIC SCOPE REPLACEMENT: a successful new REWE browser import REPLACES
  // every prior REWE-browser-scope offer in current/nextWeek/filtered (and its
  // offerScopes), instead of merging by id. This removes stale parser artefacts
  // ("Tiefkühl", "An der Bedientheke") and cross-run duplicates. Non-REWE offers
  // and other stores are untouched. The mutation block below is synchronous
  // (no await between read and write) ⇒ effectively atomic.
  // Drop old scope offers from offerScopes so the summary is rebuilt cleanly.
  for (const offer of [...snapshot.offers, ...snapshot.nextWeekOffers, ...snapshot.filteredOffers]) {
    if (isReweBrowserScopeOffer(offer)) {
      delete snapshot.offerScopes[offer.id];
    }
  }
  const scopeReplacement = replaceReweScopeOffers(
    {
      current: snapshot.offers,
      nextWeek: snapshot.nextWeekOffers,
      filtered: snapshot.filteredOffers,
    },
    { current: weekSplit.current, nextWeek: weekSplit.next, filtered: strictFilterResult.removedOffers },
  );
  const replacedPreviousCount = scopeReplacement.replacedPreviousCount;
  snapshot.offers = scopeReplacement.current;
  snapshot.nextWeekOffers = scopeReplacement.nextWeek;
  snapshot.filteredOffers = scopeReplacement.filtered;
  markOffersWithScope(snapshot.offerScopes, normalized.offers, 'local');

  // P5: ehrliche Aufteilung des Filtered-Buckets statt der pauschalen Gesamtzahl.
  // `filteredNonFood` darf NUR regelbestätigtes Non-Food zählen; falsch
  // gefiltertes Food (rescue) und ungeklärte Fälle (review) erscheinen getrennt.
  // Dieselbe zentrale Klassifikation wie Food-Rescue, Scan-Report und Store-
  // Import-Health (partitionFilteredOffersForCompleteness).
  if (normalized.report.completeness) {
    const filteredPartition = partitionFilteredOffersForCompleteness(
      strictFilterResult.removedOffers,
    );
    normalized.report.completeness.filteredNonFood = filteredPartition.ruleNonFoodNames.length;
    normalized.report.completeness.filteredFoodSuspect = filteredPartition.suspectNames.length;
    normalized.report.completeness.filteredReview = filteredPartition.unconfirmedNames.length;
  }
  normalized.report.replacedPreviousCount = replacedPreviousCount;

  const acceptedOffers = [...weekSplit.current, ...weekSplit.next];
  const addedCount = [...acceptedOffers, ...strictFilterResult.removedOffers].filter(
    (offer) => !knownIds.has(offer.id),
  ).length;
  const importWarning =
    `Hinweis: REWE Browser-Import: ${acceptedOffers.length} Angebot(e) uebernommen` +
    (strictFilterResult.removedCount > 0
      ? `, ${strictFilterResult.removedCount} Nicht-Lebensmittel gefiltert`
      : '') +
    (replacedPreviousCount.total > 0
      ? `, ${replacedPreviousCount.total} vorherige REWE-Angebote ersetzt`
      : '') +
    (weekSplit.other.length > 0
      ? `, ${weekSplit.other.length} ausserhalb dieser/naechster Woche ignoriert`
      : '') +
    '.';
  // Warning-Level-Befunde (z. B. Quelle enthaelt nicht geparste Angebote) sichtbar machen statt still.
  const browserQualityWarning =
    browserQuality.health !== 'ok' && browserQuality.reasons.length > 0
      ? `Hinweis: REWE Import-Qualität (${browserQuality.health}): ${browserQuality.reasons.join(' ')}`
      : undefined;
  // Importierte REWE-Angebote durch dieselbe Phase-2-Analyse schicken.
  const phase2Warning = await maybeStartPhase2AfterReweImport('browser');
  snapshot.warnings = sanitizeWarnings([
    ...snapshot.warnings.filter(
      (warning) =>
        !/REWE: offizielle Angebotsseite.*Anti-Bot/i.test(warning) &&
        !/REWE PDF wirkt unvollstaendig/i.test(warning) &&
        !/^Hinweis: REWE Import-Qualität/i.test(warning) &&
        !/^Hinweis: REWE-Import wartet auf Phase-2-Analyse/i.test(warning) &&
        !/^Hinweis: REWE (?:Browser|Screenshot|PDF)-Import:/i.test(warning),
    ),
    importWarning,
    ...(browserQualityWarning ? [browserQualityWarning] : []),
    ...(phase2Warning ? [phase2Warning] : []),
  ]);
  snapshot.updatedAt = new Date().toISOString();
  await saveSnapshot();

  // Cheffity Auto-Sync after a successful REWE import commit. If a background
  // Phase-2 scan was started (phase2Warning === null), the sync is deferred to
  // that scan's Phase-2 done-hook to avoid a double sync; only a deferred import
  // (Ollama down / checkpoint busy) syncs inline here. Quality-gate rejects
  // returned above before saveSnapshot and never reach this point. Fail-soft.
  if (shouldSyncAfterReweImport({ committed: true, phase2Started: phase2Warning === null })) {
    await runCheffitySyncForCurrentSnapshot('rewe_browser_import', { scanType: 'rewe_browser_import' });
  }

  appendBackendDebugLog('info', 'offers.reweBrowserImport.completed', {
    receivedCount: validation.data.offers.length,
    normalizedCount: normalized.offers.length,
    liveImportedCount: weekSplit.current.length,
    nextWeekImportedCount: weekSplit.next.length,
    filteredCount: strictFilterResult.removedCount,
    skippedCount: normalized.skippedCount,
    replacedPreviousCount,
    addedCount,
  });

  response.json({
    ok: true,
    receivedCount: validation.data.offers.length,
    normalizedCount: normalized.offers.length,
    importedCount: acceptedOffers.length,
    addedCount,
    replacedPreviousCount,
    liveImportedCount: weekSplit.current.length,
    nextWeekImportedCount: weekSplit.next.length,
    filteredCount: strictFilterResult.removedCount,
    skippedCount: normalized.skippedCount,
    offers: snapshot.offers,
    nextWeekOffers: snapshot.nextWeekOffers,
    filteredOffers: snapshot.filteredOffers,
    offerScopes: snapshot.offerScopes,
    scopeSummary: getOfferScopeSummary(),
    localSources: getLocalSourceSummary(),
    updatedAt: snapshot.updatedAt,
    warnings: snapshot.warnings,
    ingest: ingestState,
    system: getManagedProcessStatus(),
  });
});

// Manual, on-demand Lidl page-image import (see lidlPageOfferImport.ts /
// lidlPageOfferImageResolver.ts / lidlPageOfferImageSearch.ts): reads Lidl's
// Prospekt-BILDSEITEN via OCR/Vision (off by default in the automatic weekly
// scan) and resolves a real product photo per offer via Google Custom Search
// instead of the shared flyer-page image. Deliberately separate from
// scan-v2/weekly-scan — this is a slow (several minutes), explicitly
// user-triggered action, never part of the automatic scan.
const lidlPageImageImportRequestSchema = z.object({
  ocrMode: z.enum(['off', 'diagnostic', 'live']).optional(),
  visionMode: z.enum(['off', 'diagnostic', 'live']).optional(),
  imageLimit: z.number().int().min(0).max(200).optional(),
  dryRun: z.boolean().optional(),
});

type LidlPageImageImportRequest = z.infer<typeof lidlPageImageImportRequestSchema>;

function startLidlPageImageImportBackground(input: LidlPageImageImportRequest): void {
  const dryRun = input.dryRun === true;
  lidlPageImageImportState.running = true;
  lidlPageImageImportState.message = 'Lidl-Prospektbilder-Import gestartet…';
  lidlPageImageImportState.startedAt = new Date().toISOString();
  lidlPageImageImportState.finishedAt = null;
  lidlPageImageImportState.lastError = null;

  void (async () => {
    try {
      const searchCreds = resolveImageSearchConfigFromEnv();
      const searchConfig: ImageSearchConfig | null = searchCreds ? { ...searchCreds } : null;

      const importResult = await runLidlPageImageImport({
        ocrMode: input.ocrMode ?? appConfig.lidlOcrMode,
        visionMode: input.visionMode ?? appConfig.lidlVisionMode,
        imageLimit: input.imageLimit,
        imageSearch: { searchConfig },
      });

      if (importResult.offers.length === 0) {
        lidlPageImageImportState.lastResult = {
          candidatesFound: 0,
          searched: importResult.imageStats.searched,
          replacedWithSearchImage: 0,
          keptFallbackPageImage: 0,
          searchErrors: importResult.imageStats.searchErrors,
          dryRun,
        };
        lidlPageImageImportState.message =
          'Keine neuen Lidl-Bildseiten-Angebote gefunden (OCR/Vision lieferten 0 Kandidaten).';
        appendBackendDebugLog('warn', 'offers.lidlPageImageImport.empty', {
          warnings: importResult.warnings,
        });
        return;
      }

      if (dryRun) {
        lidlPageImageImportState.lastResult = {
          candidatesFound: importResult.offers.length,
          searched: importResult.imageStats.searched,
          replacedWithSearchImage: importResult.imageStats.replacedWithSearchImage,
          keptFallbackPageImage: importResult.imageStats.keptFallbackPageImage,
          searchErrors: importResult.imageStats.searchErrors,
          dryRun: true,
        };
        lidlPageImageImportState.message =
          `Dry-Run: ${importResult.offers.length} Angebot(e) gefunden, ` +
          `${importResult.imageStats.replacedWithSearchImage} mit Web-Bild, ` +
          `${importResult.imageStats.keptFallbackPageImage} mit Prospekt-Fallback-Bild.`;
        appendBackendDebugLog('info', 'offers.lidlPageImageImport.dryRun', {
          candidatesFound: importResult.offers.length,
          ...importResult.imageStats,
          warnings: importResult.warnings,
        });
        return;
      }

      // Compute the new offers FIRST (no snapshot mutation yet) so a failure
      // before this point leaves the previous snapshot fully intact — same
      // ordering discipline as the REWE browser import above.
      const normalized = normalizeOffers(importResult.offers);
      const strict = filterOffersStrictFood(normalized);
      const imageCheck = await checkOffersImages([...strict.offers, ...strict.removedOffers]);
      const acceptedIds = new Set(strict.offers.map((offer) => offer.id));
      const checkedAccepted = imageCheck.offers.filter((offer) => acceptedIds.has(offer.id));
      const checkedRemoved = imageCheck.offers.filter((offer) => !acceptedIds.has(offer.id));
      const weekSplit = splitOffersByWeek(checkedAccepted);

      // ATOMIC SCOPE REPLACEMENT (mirrors the REWE browser import above): a
      // successful run REPLACES every prior `lidl-prospekt-bildseite` offer in
      // current/nextWeek/filtered — the already-working structured Lidl
      // offers (real Lidl CDN photos) and every other store are untouched.
      for (const offer of [...snapshot.offers, ...snapshot.nextWeekOffers, ...snapshot.filteredOffers]) {
        if (isLidlPageImageScopeOffer(offer)) {
          delete snapshot.offerScopes[offer.id];
        }
      }
      const scopeReplacement = replaceLidlPageImageScopeOffers(
        { current: snapshot.offers, nextWeek: snapshot.nextWeekOffers, filtered: snapshot.filteredOffers },
        { current: weekSplit.current, nextWeek: weekSplit.next, filtered: checkedRemoved },
      );
      snapshot.offers = scopeReplacement.current;
      snapshot.nextWeekOffers = scopeReplacement.nextWeek;
      snapshot.filteredOffers = scopeReplacement.filtered;
      markOffersWithScope(snapshot.offerScopes, normalized, 'national');

      const importWarning =
        `Hinweis: Lidl-Prospektbilder-Import: ${weekSplit.current.length + weekSplit.next.length} Angebot(e) uebernommen` +
        ` (${importResult.imageStats.replacedWithSearchImage} mit Web-Bild, ` +
        `${importResult.imageStats.keptFallbackPageImage} mit Prospekt-Fallback-Bild)` +
        (strict.removedCount > 0 ? `, ${strict.removedCount} Nicht-Lebensmittel gefiltert` : '') +
        (scopeReplacement.replacedPreviousCount.total > 0
          ? `, ${scopeReplacement.replacedPreviousCount.total} vorherige Lidl-Bildseiten-Angebote ersetzt`
          : '') +
        '.';

      // Importierte Angebote durch dieselbe Phase-2-Analyse schicken (1:1 wie
      // der REWE-Import) — keine Aenderung an Phase 2 selbst noetig.
      const phase2Warning = await maybeStartPhase2AfterReweImport(
        'lidl_page_image_import',
        'Lidl-Prospektbilder-Import (OCR/Vision + Bildsuche)',
      );
      snapshot.warnings = sanitizeWarnings([
        ...snapshot.warnings.filter(
          (warning) => !/^Hinweis: Lidl-Prospektbilder-Import:/i.test(warning),
        ),
        importWarning,
        ...(phase2Warning ? [phase2Warning] : []),
      ]);
      snapshot.updatedAt = new Date().toISOString();
      await saveSnapshot();

      if (shouldSyncAfterReweImport({ committed: true, phase2Started: phase2Warning === null })) {
        await runCheffitySyncForCurrentSnapshot('lidl_page_image_import', {
          scanType: 'lidl_page_image_import',
        });
      }

      lidlPageImageImportState.lastResult = {
        candidatesFound: importResult.offers.length,
        searched: importResult.imageStats.searched,
        replacedWithSearchImage: importResult.imageStats.replacedWithSearchImage,
        keptFallbackPageImage: importResult.imageStats.keptFallbackPageImage,
        searchErrors: importResult.imageStats.searchErrors,
        dryRun: false,
      };
      lidlPageImageImportState.message = importWarning;
      appendBackendDebugLog('info', 'offers.lidlPageImageImport.completed', {
        candidatesFound: importResult.offers.length,
        liveCount: weekSplit.current.length,
        nextWeekCount: weekSplit.next.length,
        filteredCount: checkedRemoved.length,
        replacedWithSearchImage: importResult.imageStats.replacedWithSearchImage,
        keptFallbackPageImage: importResult.imageStats.keptFallbackPageImage,
        searchErrors: importResult.imageStats.searchErrors,
        replacedPreviousCount: scopeReplacement.replacedPreviousCount,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
      lidlPageImageImportState.lastError = message;
      lidlPageImageImportState.message = `Fehler: ${message}`;
      appendBackendDebugLog('error', 'offers.lidlPageImageImport.failed', { error: message });
    } finally {
      lidlPageImageImportState.running = false;
      lidlPageImageImportState.finishedAt = new Date().toISOString();
    }
  })();
}

app.post('/api/offers/lidl-page-image-import', (request, response) => {
  const validation = lidlPageImageImportRequestSchema.safeParse(request.body ?? {});
  if (!validation.success) {
    response.status(400).json({
      error: 'Ungueltige Lidl-Prospektbilder-Import-Payload.',
      details: validation.error.flatten(),
    });
    return;
  }

  if (lidlPageImageImportState.running) {
    response.status(409).json({
      error: 'Lidl-Prospektbilder-Import laeuft bereits.',
      job: lidlPageImageImportState,
    });
    return;
  }
  const allowed = canStartScanV2();
  if (!allowed.ok) {
    response.status(allowed.status).json({ error: allowed.error });
    return;
  }
  const disabled = parseDisabledStores(appConfig.offersDisabledStores);
  if (isStoreDisabled('Lidl', disabled)) {
    response.status(409).json({
      error: 'Lidl ist administrativ deaktiviert (offersDisabledStores) — Import nicht gestartet.',
    });
    return;
  }

  startLidlPageImageImportBackground(validation.data);
  appendBackendDebugLog('info', 'offers.lidlPageImageImport.start.accepted', {
    ocrMode: validation.data.ocrMode,
    visionMode: validation.data.visionMode,
    imageLimit: validation.data.imageLimit,
    dryRun: validation.data.dryRun === true,
  });
  response.status(202).json({
    ok: true,
    message: 'Lidl-Prospektbilder-Import gestartet.',
    job: lidlPageImageImportState,
  });
});

app.get('/api/offers/article/:articleId', (request, response) => {
  const articleId = String(request.params.articleId ?? '').trim();
  if (!isArticleId(articleId)) {
    response.status(400).json({ error: 'Ungueltige articleId.' });
    return;
  }

  const currentOffers = offersForArticleId(snapshot.offers, articleId).sort(
    (left, right) => left.price - right.price,
  );
  const nextWeekOffers = offersForArticleId(snapshot.nextWeekOffers, articleId).sort(
    (left, right) => left.price - right.price,
  );

  response.json({
    articleId,
    isOnOffer: currentOffers.length > 0,
    currentOffers: serializeOffersForApi(currentOffers),
    nextWeekOffers: serializeOffersForApi(nextWeekOffers),
    locations: currentOffers.map((offer) => ({
      offerId: offer.id,
      storeChain: offer.storeChain,
      storeId: offer.storeId ?? null,
      storeAddress: offer.storeAddress ?? null,
      storeCity: offer.storeCity ?? null,
      postalCode: offer.postalCode ?? null,
      distanceKm: offer.distanceKm ?? null,
      price: offer.price,
      currency: offer.currency,
      validityStart: offer.validityStart,
      validityEnd: offer.validityEnd,
    })),
    updatedAt: snapshot.updatedAt,
  });
});

app.get('/api/offers', (_request, response) => {
  appendBackendDebugLog('info', 'offers.read', {
    offersCount: snapshot.offers.length,
    nextWeekOffersCount: snapshot.nextWeekOffers.length,
    filteredOffersCount: snapshot.filteredOffers.length,
    scopeSummary: getOfferScopeSummary(),
    updatedAt: snapshot.updatedAt,
  });
  response.json({
    offers: serializeOffersForApi(snapshot.offers),
    nextWeekOffers: serializeOffersForApi(snapshot.nextWeekOffers),
    filteredOffers: serializeOffersForApi(snapshot.filteredOffers),
    offerScopes: snapshot.offerScopes,
    scopeSummary: getOfferScopeSummary(),
    localSources: getLocalSourceSummary(),
    updatedAt: snapshot.updatedAt,
    warnings: snapshot.warnings,
    ingest: ingestState,
    aiRescan: aiRescanState,
    oneClickAi: oneClickAiState,
    system: getManagedProcessStatus(),
  });
});

/**
 * Snapshot-DATEI zum Herunterladen — nicht der Live-Bucket.
 *
 * Zweck: denselben Datenstand auf einen zweiten Rechner bringen (Demo-Laptop).
 * `backend/data/offers.json` ist gitignored, kommt also nicht ueber einen Pull
 * mit. Geliefert wird die Datei so, wie dieses Backend sie beim Start liest —
 * NICHT der In-Memory-Stand, damit heruntergeladene und gelesene Daten
 * garantiert identisch sind.
 *
 * Dateiname bleibt bewusst `offers.json`: nur unter diesem Namen ist die Datei
 * am Zielort ein direkter Ersatz, ohne Umbenennen.
 */
app.get('/api/offers/snapshot/download', (_request, response) => {
  const filePath = getOffersDataFile();
  if (!existsSync(filePath)) {
    appendBackendDebugLog('warn', 'offers.snapshot.download.missing', { filePath });
    response.status(404).json({
      error: 'Keine Snapshot-Datei vorhanden — es wurde auf diesem Rechner noch nie gespeichert.',
    });
    return;
  }

  appendBackendDebugLog('info', 'offers.snapshot.download', {
    filePath,
    offersCount: snapshot.offers.length,
    nextWeekOffersCount: snapshot.nextWeekOffers.length,
    updatedAt: snapshot.updatedAt,
  });

  response.download(filePath, 'offers.json', (error) => {
    // Nach begonnenem Stream ist kein JSON-Fehler mehr moeglich — nur noch loggen.
    if (error) {
      appendBackendDebugLog('warn', 'offers.snapshot.download.failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
});

app.get('/api/offers/live/download', (request, response) => {
  const format = String(request.query.format ?? 'json')
    .trim()
    .toLowerCase();
  const count = snapshot.offers.length;
  const stamp = fileTimestamp();

  if (format !== 'json' && format !== 'csv') {
    response.status(400).json({
      error: 'Ungueltiges Format. Erlaubt: json oder csv.',
    });
    return;
  }

  appendBackendDebugLog('info', 'offers.live.download', {
    format,
    count,
    updatedAt: snapshot.updatedAt,
  });

  if (format === 'csv') {
    const csv = offersToCsv(snapshot.offers);
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="aichef_live_offers_${stamp}.csv"`,
    );
    response.status(200).send(`\uFEFF${csv}`);
    return;
  }

  const payload = {
    exportedAt: new Date().toISOString(),
    updatedAt: snapshot.updatedAt,
    offersCount: count,
    offers: snapshot.offers,
    nextWeekOffersCount: snapshot.nextWeekOffers.length,
    offerScopes: snapshot.offerScopes,
    scopeSummary: {
      live: countOffersByScope(snapshot.offers),
      nextWeek: countOffersByScope(snapshot.nextWeekOffers),
    },
    warnings: snapshot.warnings,
  };

  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader(
    'Content-Disposition',
    `attachment; filename="aichef_live_offers_${stamp}.json"`,
  );
  response.status(200).send(JSON.stringify(payload, null, 2));
});

app.get('/api/offers/filtered', (_request, response) => {
  appendBackendDebugLog('info', 'offers.filtered.read', {
    filteredOffersCount: snapshot.filteredOffers.length,
    nextWeekOffersCount: snapshot.nextWeekOffers.length,
    scopeSummary: getOfferScopeSummary(),
    updatedAt: snapshot.updatedAt,
  });
  response.json({
    offers: serializeOffersForApi(snapshot.offers),
    nextWeekOffers: serializeOffersForApi(snapshot.nextWeekOffers),
    filteredOffers: serializeOffersForApi(snapshot.filteredOffers),
    offerScopes: snapshot.offerScopes,
    scopeSummary: getOfferScopeSummary(),
    updatedAt: snapshot.updatedAt,
    warnings: snapshot.warnings,
    ingest: ingestState,
    aiRescan: aiRescanState,
    oneClickAi: oneClickAiState,
    system: getManagedProcessStatus(),
  });
});

app.get('/api/offers/next-week', (_request, response) => {
  appendBackendDebugLog('info', 'offers.nextWeek.read', {
    offersCount: snapshot.nextWeekOffers.length,
    updatedAt: snapshot.updatedAt,
  });
  response.json({
    offers: serializeOffersForApi(snapshot.offers),
    nextWeekOffers: serializeOffersForApi(snapshot.nextWeekOffers),
    filteredOffers: serializeOffersForApi(snapshot.filteredOffers),
    offerScopes: snapshot.offerScopes,
    scopeSummary: getOfferScopeSummary(),
    updatedAt: snapshot.updatedAt,
    warnings: snapshot.warnings,
    ingest: ingestState,
    aiRescan: aiRescanState,
    oneClickAi: oneClickAiState,
    system: getManagedProcessStatus(),
  });
});

app.get('/api/offers/next-week/download', (request, response) => {
  const format = String(request.query.format ?? 'json')
    .trim()
    .toLowerCase();
  const count = snapshot.nextWeekOffers.length;
  const stamp = fileTimestamp();

  if (format !== 'json' && format !== 'csv') {
    response.status(400).json({
      error: 'Ungueltiges Format. Erlaubt: json oder csv.',
    });
    return;
  }

  appendBackendDebugLog('info', 'offers.nextWeek.download', {
    format,
    count,
    updatedAt: snapshot.updatedAt,
  });

  if (format === 'csv') {
    const csv = offersToCsv(snapshot.nextWeekOffers);
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="aichef_next_week_offers_${stamp}.csv"`,
    );
    response.status(200).send(`\uFEFF${csv}`);
    return;
  }

  const payload = {
    exportedAt: new Date().toISOString(),
    updatedAt: snapshot.updatedAt,
    offersCount: count,
    nextWeekOffers: snapshot.nextWeekOffers,
    offerScopes: snapshot.offerScopes,
    scopeSummary: {
      live: countOffersByScope(snapshot.offers),
      nextWeek: countOffersByScope(snapshot.nextWeekOffers),
      filtered: countOffersByScope(snapshot.filteredOffers),
    },
    warnings: snapshot.warnings,
  };

  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader(
    'Content-Disposition',
    `attachment; filename="aichef_next_week_offers_${stamp}.json"`,
  );
  response.status(200).send(JSON.stringify(payload, null, 2));
});

app.get('/api/offers/filtered/download', (request, response) => {
  const format = String(request.query.format ?? 'json')
    .trim()
    .toLowerCase();
  const count = snapshot.filteredOffers.length;
  const stamp = fileTimestamp();

  if (format !== 'json' && format !== 'csv') {
    response.status(400).json({
      error: 'Ungueltiges Format. Erlaubt: json oder csv.',
    });
    return;
  }

  appendBackendDebugLog('info', 'offers.filtered.download', {
    format,
    count,
    updatedAt: snapshot.updatedAt,
  });

  if (format === 'csv') {
    const csv = offersToCsv(snapshot.filteredOffers);
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="aichef_filtered_offers_${stamp}.csv"`,
    );
    response.status(200).send(`\uFEFF${csv}`);
    return;
  }

  const payload = {
    exportedAt: new Date().toISOString(),
    updatedAt: snapshot.updatedAt,
    offersCount: count,
    nextWeekOffersCount: snapshot.nextWeekOffers.length,
    filteredOffers: snapshot.filteredOffers,
    offerScopes: snapshot.offerScopes,
    scopeSummary: {
      live: countOffersByScope(snapshot.offers),
      nextWeek: countOffersByScope(snapshot.nextWeekOffers),
      filtered: countOffersByScope(snapshot.filteredOffers),
    },
    warnings: snapshot.warnings,
  };

  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader(
    'Content-Disposition',
    `attachment; filename="aichef_filtered_offers_${stamp}.json"`,
  );
  response.status(200).send(JSON.stringify(payload, null, 2));
});

function buildQualityReport() {
  return computeQualityReport({
    offers: snapshot.offers,
    filteredOffers: snapshot.filteredOffers,
    nextWeekOffers: snapshot.nextWeekOffers,
    updatedAt: snapshot.updatedAt,
    ingest: ingestState,
    aiRun: oneClickAiState,
  });
}

app.get('/api/offers/quality', (_request, response) => {
  const report = buildQualityReport();
  appendBackendDebugLog('info', 'offers.quality.read', {
    liveTotal: report.kpis.liveTotal,
    storeCount: report.kpis.storeCount,
    reviewCount: report.review.length,
  });
  response.json(report);
});

app.get('/api/offers/quality/download', (_request, response) => {
  const report = buildQualityReport();
  const stamp = fileTimestamp();
  appendBackendDebugLog('info', 'offers.quality.download', {
    liveTotal: report.kpis.liveTotal,
    reviewCount: report.review.length,
  });
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader(
    'Content-Disposition',
    `attachment; filename="aichef_offers_quality_${stamp}.json"`,
  );
  response.status(200).send(JSON.stringify(report, null, 2));
});

// Post-scan completeness/verification report (Task E): per-store imported vs
// expected/official, blocked/unverified stores and — when a Kaufland scrape has
// run this process — the official-vs-imported gap with concrete missing
// examples. Pure aggregation over the current snapshot, so it is cheap + safe.
// Last REWE PDF/Web import quality report, captured when an import runs, so the
// scan-report can surface fragments/suspicious prices/category corrections.
let lastReweImportReport: ReweImportReportData | null = null;
// How the last REWE data reached us (browser bookmarklet vs screenshot/PDF), so
// the per-shop health report is honest about which import path actually ran.
let lastReweImportMethod: 'browser' | 'pdf' | null = null;

/**
 * Kaufland-Vollständigkeit zur REPORT-Zeit gegen den echten Snapshot rechnen
 * (End-to-End: ein offizielles Food-Angebot, das importiert, aber falsch in
 * den Filtered-Bucket einsortiert wurde, zählt als matchedFiltered — nicht als
 * "vollständig"). Fällt auf die Scrape-Zeit-Messung zurück, wenn in diesem
 * Prozess (noch) keine SSR-Analyse vorliegt (z. B. nach Neustart ohne Scan).
 */
function buildSnapshotKauflandCompleteness() {
  const analysis = getLastKauflandAnalysis();
  if (!analysis) {
    return getLastKauflandCompleteness();
  }
  const isKaufland = (offer: Offer): boolean =>
    offer.storeChain?.trim().toLowerCase() === 'kaufland';
  // Filtered dreiteilen — EXAKT nach dem Rescue-Verdict (Report == Rescue):
  // 'keep' (Regel-Non-Food/Lock/Fragment) erklärt die Lücke, 'rescue'-würdig
  // in filtered ist echter Food-Verdacht, 'review' (kein Beleg in beide
  // Richtungen) ist nur bei offizieller Food-Kategorie ein Verdacht — der
  // Tankini/Holzkohle-Fall aus gemischten Promo-Kategorien zählt als
  // erklärter Review-Fall (matchedFilteredUnconfirmed). Bewusst OHNE
  // Modell-Verdikt, das selbst falsch sein kann (Bratmaxe-Fall).
  const filteredKaufland = snapshot.filteredOffers.filter(isKaufland);
  const partition = partitionFilteredOffersForCompleteness(filteredKaufland);
  return buildKauflandCompleteness(analysis, {
    currentNames: snapshot.offers.filter(isKaufland).map((offer) => offer.name),
    nextWeekNames: snapshot.nextWeekOffers.filter(isKaufland).map((offer) => offer.name),
    filteredNames: partition.suspectNames,
    filteredNonFoodNames: partition.ruleNonFoodNames,
    filteredUnconfirmedNames: partition.unconfirmedNames,
  });
}

function buildScanVerificationReport() {
  const kauflandAnalysis = getLastKauflandAnalysis();
  const kauflandCompleteness = buildSnapshotKauflandCompleteness();
  const officialCounts: Record<string, number> = {};
  if (kauflandAnalysis) {
    // Like-for-like denominator: the snapshot counts DISTINCT offers, so the
    // expectation must too. officialFoodishCount counts SSR offer OBJECTS
    // (same product duplicated across category blocks → 577 vs 369 distinct),
    // which deflated the score and flagged a complete import as critical.
    const distinct =
      kauflandAnalysis.currentFoodOffers.length > 0
        ? kauflandAnalysis.currentFoodOffers.length
        : kauflandAnalysis.officialFoodishCount;
    // Erklärtes Non-Food aus gemischten offiziellen Promo-Kategorien (regel-
    // bestätigt bzw. Review-Fall ohne Food-Beleg) ist KEIN erwartetes Food:
    // es bleibt korrekt im Filtered-Bucket. Ohne den Abzug drückt es den
    // Completeness-Score (313/421 = "74 %"), obwohl kein Angebot fehlt.
    // Echte Verdachtsfälle (matchedFiltered) und Fehlende bleiben im Nenner.
    const explainedNonFood = kauflandCompleteness
      ? kauflandCompleteness.matchedFilteredNonFoodCount +
        kauflandCompleteness.matchedFilteredUnconfirmedCount
      : 0;
    officialCounts.kaufland = Math.max(0, distinct - explainedNonFood);
  }
  return buildScanReport({
    offers: snapshot.offers,
    nextWeekOffers: snapshot.nextWeekOffers,
    filteredOffers: snapshot.filteredOffers,
    officialCounts,
    // Laufzeit-Erwartungen: nahkauf gilt nur mit konfigurierter Markt-ID als
    // voll abgedeckt; ohne bleibt der Status ehrlich "national_only".
    expectations: buildStoreExpectations({ nahkaufMarketId: appConfig.nahkaufMarketId }),
    kauflandCompleteness,
    // EDEKA-Import-Diagnose des letzten Scrapes (Zählkette + blocked/empty), damit
    // der Report EDEKA ehrlich zeigt (reachable+parsed vs. blocked vs. leer) und
    // EDEKA bei 0 Angeboten nie still aus dem Report verschwindet.
    edeka: getLastEdekaDiagnostics(),
    // ALDI-NORD-Import-Diagnose (strukturierter Website-Connector): ehrliche
    // Zählkette + apiData/blocked-Status, damit ALDI NORD als ok/warning statt
    // 'disabled' erscheint.
    aldiNord: getLastAldiNordDiagnostics(),
    // ALDI-SÜD-Import-Diagnose (strukturierter Website-Connector, 3 öffentliche
    // Wochenangebot-Kategorieseiten): ehrliche Zählkette + per-URL blocked-Status,
    // damit ALDI SÜD als ok/warning/blocked statt 'disabled' erscheint.
    aldiSued: getLastAldiSuedDiagnostics(),
    // nahkauf-Import-Diagnose (Storyblok-Zählkette + belegter source-gap), damit
    // 0 nahkauf-Angebote bei nachweislich leerem Publisher als warning statt
    // critical erscheinen und nahkauf nicht in criticalStores landet.
    nahkauf: getLastNahkaufDiagnostics(),
    reweImport: lastReweImportReport,
    reweImportMethod: lastReweImportMethod,
    // Lauf-Kontext (Task P3): ein phase2-only-Lauf hat keine Phase-1-Diagnosen
    // (REWE-Import/Subquellen-Scrape) frisch erzeugt — der Report zeigt das
    // ehrlich als `not_refreshed`, statt die Felder kontextlos leer zu lassen.
    runContext:
      scanV2State.mode === 'phase2'
        ? 'phase2-only'
        : scanV2State.mode === 'phase1'
          ? 'phase1'
          : 'full',
    // Ausgeschlossene Shops (REWE/nahkauf) ohne Import gelten als
    // excluded/skipped, nicht critical.
    excludedStores: parseExcludedStores(appConfig.weeklyScanExcludedStores),
    // Per Policy deaktivierte Shops (ALDI SÜD/NORD, Lidl): erscheinen als
    // 'disabled', nie critical, keine Mindestmengen-Warnung.
    disabledStores: disabledStoreDisplayNames(appConfig.offersDisabledStores),
    // Vollständige Subquellen-/Prospektbilanz des letzten Commit-Versuchs (Task P6).
    subSourceOutcomes: getLastSubSourceOutcomes(),
  });
}

// Der Report-Build ist rein CPU-gebunden und blockiert mehrere Sekunden den
// Event-Loop. Ohne Cache stapelte das automatische Dashboard-Polling (Imports-
// Tab) mehrere solche Builds hintereinander und hungerte /api/health komplett aus
// — der Prozess wirkte „weg". Der Cache coalesct gleichzeitige Aufrufe zu EINEM
// Build und hält das Ergebnis kurz vor; invalidateScanReportCache() macht ihn
// nach jedem Snapshot-Wechsel wieder frisch. Siehe scanReportCache.ts.
// TTL bewusst großzügig (30 s): der Report ändert sich nur bei einem Snapshot-
// Wechsel, und der löst invalidateScanReportCache() ohnehin sofort aus. Ein
// längeres Fenster reduziert die Zahl der teuren Builds, ohne je veraltete
// Falschzahlen zu liefern (invalidate verwirft den Cache hart).
const scanReportCache = createScanReportCache<ScanReport>({ ttlMs: 30_000 });

function invalidateScanReportCache(): void {
  scanReportCache.invalidate();
}

/** Liefert den (gecachten/coalescten) Verifikations-Report mitsamt einmalig
 *  serialisierter JSON-Payload. Der Build bleibt synchron; der Cache verhindert
 *  paralleles/wiederholtes Rechnen UND wiederholtes Serialisieren, und liefert
 *  abgelaufene Stände per stale-while-revalidate sofort aus (Loop bleibt frei). */
function getCachedScanReportEntry() {
  return scanReportCache.getEntry(() => buildScanVerificationReport());
}

app.get('/api/offers/scan-report', async (request, response) => {
  // Response-Lifecycle protokollieren: ein vom Client abgebrochener (keep-alive/
  // abort) Request darf den Prozess nie destabilisieren. 'close' ohne vorheriges
  // 'finish' = Client ist vor dem vollständigen Senden gegangen — rein informativ,
  // nie fatal. Bestätigt zugleich, dass der Burst sauber endet.
  let finished = false;
  response.on('finish', () => {
    finished = true;
  });
  response.on('close', () => {
    if (!finished) {
      appendBackendDebugLog('warn', 'offers.scanReport.clientAborted', {
        aborted: request.aborted ?? null,
      });
    }
  });
  response.on('error', (error) => {
    appendBackendDebugLog('error', 'offers.scanReport.responseError', {
      error: stringifyUnknownError(error),
    });
  });
  try {
    const { value: report, json } = await getCachedScanReportEntry();
    appendBackendDebugLog('info', 'offers.scanReport.read', {
      storeCount: report.completeness.stores.length,
      blocked: report.blockedStores,
      critical: report.criticalStores,
      kauflandMissing: report.kauflandCompleteness?.missingEstimate ?? null,
    });
    // Die fertige JSON-Payload direkt senden — kein erneutes JSON.stringify auf
    // demselben großen Objekt pro (Burst-)Request.
    response.set('Content-Type', 'application/json; charset=utf-8').send(json);
  } catch (error) {
    // Ein Build-/Serialisierungsfehler darf den Prozess NIE beenden — ehrlich als
    // 500 melden statt eine unbehandelte Exception eskalieren zu lassen.
    appendBackendDebugLog('error', 'offers.scanReport.failed', {
      error: stringifyUnknownError(error),
    });
    response.status(500).json({ error: 'scan-report konnte nicht erstellt werden.' });
  }
});

app.get('/api/offers/scan-report/download', async (_request, response) => {
  try {
    const { value: report } = await getCachedScanReportEntry();
    const markdown = renderScanReportMarkdown(report);
    const stamp = fileTimestamp();
    response.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="aichef_scan_report_${stamp}.md"`,
    );
    response.status(200).send(markdown);
  } catch (error) {
    appendBackendDebugLog('error', 'offers.scanReport.download.failed', {
      error: stringifyUnknownError(error),
    });
    response.status(500).json({ error: 'scan-report konnte nicht erstellt werden.' });
  }
});

// ─── /admin-v2 backend APIs ────────────────────────────────────────────────
// Aggregated read-only endpoints. Cached in adminAggregator with a 15 s TTL.
// Mutations stay on the existing /api/offers/* and /api/system/* routes.

function toAdminProcess(p: {
  running: boolean;
  message?: string;
  stage?: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  total?: number;
  processed?: number;
}): AdminProcessSummary {
  return {
    running: p.running,
    stage: p.stage ?? null,
    message: p.message ?? null,
    startedAt: p.startedAt,
    finishedAt: p.finishedAt,
    lastError: p.lastError,
    total: typeof p.total === 'number' ? p.total : null,
    processed: typeof p.processed === 'number' ? p.processed : null,
  };
}

function buildJobsState(): AdminJobsState {
  const system = getManagedProcessStatus();
  const pull = getOllamaPullStatus();
  const history = [
    {
      kind: 'ingest' as const,
      startedAt: ingestState.startedAt,
      finishedAt: ingestState.finishedAt,
      status: (ingestState.running
        ? 'running'
        : ingestState.lastError
          ? 'error'
          : ingestState.finishedAt
            ? 'done'
            : 'idle') as 'running' | 'done' | 'error' | 'idle',
      message: ingestState.message,
      lastError: ingestState.lastError,
    },
    {
      kind: 'one_click_ai' as const,
      startedAt: oneClickAiState.startedAt,
      finishedAt: oneClickAiState.finishedAt,
      status: (oneClickAiState.running
        ? 'running'
        : oneClickAiState.lastError
          ? 'error'
          : oneClickAiState.finishedAt
            ? 'done'
            : 'idle') as 'running' | 'done' | 'error' | 'idle',
      message: oneClickAiState.message,
      lastError: oneClickAiState.lastError,
    },
    {
      kind: 'ai_rescan' as const,
      startedAt: aiRescanState.startedAt,
      finishedAt: aiRescanState.finishedAt,
      status: (aiRescanState.running
        ? 'running'
        : aiRescanState.lastError
          ? 'error'
          : aiRescanState.finishedAt
            ? 'done'
            : 'idle') as 'running' | 'done' | 'error' | 'idle',
      message: aiRescanState.message,
      lastError: aiRescanState.lastError,
    },
    {
      kind: 'ollama_pull' as const,
      startedAt: pull.startedAt,
      finishedAt: pull.finishedAt,
      status: (pull.running
        ? 'running'
        : pull.lastError
          ? 'error'
          : pull.finishedAt
            ? 'done'
            : 'idle') as 'running' | 'done' | 'error' | 'idle',
      message: pull.lastOutput ?? null,
      lastError: pull.lastError,
    },
    {
      kind: 'lidl_page_image_import' as const,
      startedAt: lidlPageImageImportState.startedAt,
      finishedAt: lidlPageImageImportState.finishedAt,
      status: (lidlPageImageImportState.running
        ? 'running'
        : lidlPageImageImportState.lastError
          ? 'error'
          : lidlPageImageImportState.finishedAt
            ? 'done'
            : 'idle') as 'running' | 'done' | 'error' | 'idle',
      message: lidlPageImageImportState.message,
      lastError: lidlPageImageImportState.lastError,
    },
  ];

  const oneClickProcess: AdminProcessSummary = {
    running: oneClickAiState.running,
    stage: oneClickAiState.stage,
    message: oneClickAiState.message,
    startedAt: oneClickAiState.startedAt,
    finishedAt: oneClickAiState.finishedAt,
    lastError: oneClickAiState.lastError,
    total: oneClickAiState.total,
    processed: oneClickAiState.processed,
  };
  const ollamaProcess: AdminProcessSummary = {
    running: pull.running,
    stage: null,
    message: pull.lastOutput ?? null,
    startedAt: pull.startedAt,
    finishedAt: pull.finishedAt,
    lastError: pull.lastError,
    model: pull.model,
  };

  return {
    generatedAt: new Date().toISOString(),
    ingest: toAdminProcess(ingestState),
    oneClickAi: oneClickProcess,
    aiRescan: toAdminProcess(aiRescanState),
    ollamaPull: ollamaProcess,
    system: {
      ollama: {
        running: system.ollama.running,
        stage: null,
        message: system.ollama.description,
        startedAt: system.ollama.startedAt,
        finishedAt: system.ollama.lastStoppedAt,
        lastError: system.ollama.lastError,
        pid: system.ollama.pid,
      },
      app: {
        running: system.app.running,
        stage: null,
        message: system.app.description,
        startedAt: system.app.startedAt,
        finishedAt: system.app.lastStoppedAt,
        lastError: system.app.lastError,
        pid: system.app.pid,
      },
      mobile: {
        running: system.mobile.running,
        stage: null,
        message: system.mobile.description,
        startedAt: system.mobile.startedAt,
        finishedAt: system.mobile.lastStoppedAt,
        lastError: system.mobile.lastError,
        pid: system.mobile.pid,
      },
    },
    history,
    notes: [
      'Job-Verlauf kommt aktuell aus den In-Memory-States. Bei Neustart geht der Verlauf verloren.',
      'Vorschlag: spätere Persistenz-Tabelle public.admin_job_runs (kind text, started_at, finished_at, status, message jsonb).',
    ],
  };
}

app.get('/api/admin/overview', async (_request, response) => {
  try {
    const qualityReport = buildQualityReport();
    const system = getManagedProcessStatus();
    const overview = await getOverview({
      qualityReport,
      ingestState,
      oneClickAi: oneClickAiState,
      ollamaRunning: system.ollama.running,
      recentLogs: readBackendDebugLogs(300),
      lastSupabaseSync: lastSupabaseSyncState.at
        ? { at: lastSupabaseSyncState.at, status: lastSupabaseSyncState.status }
        : null,
    });
    appendBackendDebugLog('info', 'admin.overview.read', {
      warnings: overview.warnings.length,
      supabaseAvailable: overview.supabase.available,
    });
    response.json(overview);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
    appendBackendDebugLog('error', 'admin.overview.failed', { message });
    response.status(500).json({ error: message });
  }
});

app.get('/api/admin/subscriptions', async (_request, response) => {
  try {
    const payload = await getSubscriptions();
    appendBackendDebugLog('info', 'admin.subscriptions.read', {
      available: payload.available,
      totalUsers: payload.totalUsers,
    });
    response.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
    appendBackendDebugLog('error', 'admin.subscriptions.failed', { message });
    response.status(500).json({ error: message });
  }
});

app.get('/api/admin/trends', async (_request, response) => {
  try {
    const payload = await getTrends();
    appendBackendDebugLog('info', 'admin.trends.read', {
      available: payload.available,
      products: payload.topAddedProducts.length,
      recipes: payload.topPlannedRecipes.length,
    });
    response.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
    appendBackendDebugLog('error', 'admin.trends.failed', { message });
    response.status(500).json({ error: message });
  }
});

app.get('/api/admin/sources', (_request, response) => {
  const sources = buildSourceHealth([...snapshot.offers, ...snapshot.nextWeekOffers]);
  const payload: AdminSources = { generatedAt: new Date().toISOString(), sources };
  appendBackendDebugLog('info', 'admin.sources.read', { count: sources.length });
  response.json(payload);
});

app.get('/api/admin/jobs', (_request, response) => {
  const payload = buildJobsState();
  appendBackendDebugLog('info', 'admin.jobs.read', {
    runningCount: payload.history.filter((h) => h.status === 'running').length,
  });
  response.json(payload);
});

function categorizerRunsRoot(): string {
  return path.join(process.cwd(), 'backend', 'data', 'categorizer-runs');
}

// Read the historical categorizer-run dirs from disk (shared by GET + DELETE).
function readCategorizerDiskRuns(
  runRoot: string,
): ReturnType<typeof listCategorizerRuns> {
  return listCategorizerRuns(
    runRoot,
    async (dir) => {
      try {
        return await fsPromises.readdir(dir);
      } catch {
        return [];
      }
    },
    async (target) => {
      try {
        const s = await fsPromises.stat(target);
        return { isDirectory: () => s.isDirectory() };
      } catch {
        return null;
      }
    },
  );
}

// /api/admin/jobs/history — surfaces the in-memory job snapshot AND scans
// `backend/data/categorizer-runs/*` for historical runs. No persistent
// table yet — see the suggested `public.admin_job_runs` migration in
// docs/admin-v2-release-checklist.md if persistent history is needed.
app.get('/api/admin/jobs/history', async (_request, response) => {
  const inMemory = buildJobsState().history;
  const runRoot = categorizerRunsRoot();
  const diskRuns = await readCategorizerDiskRuns(runRoot);
  const payload: AdminJobsHistory = {
    generatedAt: new Date().toISOString(),
    source: diskRuns.length > 0 ? 'memory+disk' : 'memory',
    inMemory,
    diskRuns,
    notes: [
      'In-Memory-Verlauf geht bei jedem Backend-Neustart verloren.',
      'Persistente Historie braucht die geplante Tabelle public.admin_job_runs (siehe docs/admin-v2-release-checklist.md).',
    ],
  };
  appendBackendDebugLog('info', 'admin.jobsHistory.read', {
    memoryEntries: inMemory.length,
    diskEntries: diskRuns.length,
  });
  response.json(payload);
});

// DELETE /api/admin/jobs/history/:runId — remove a single categorizer-run dir
// from disk. Hardened against path traversal: the dir name is validated by a
// strict pattern AND the resolved path must be a direct child of runRoot (see
// resolveCategorizerRunPath). Only DISK runs are touched — in-memory job state
// is never deleted, and we refuse while a categorizer-spawning job is running so
// we can never race/remove the dir an active run owns.
app.delete('/api/admin/jobs/history/:runId', async (request, response) => {
  const runRoot = categorizerRunsRoot();
  const raw = decodeURIComponent(String(request.params.runId ?? ''));
  const target = resolveCategorizerRunPath(runRoot, raw);
  if (!target) {
    appendBackendDebugLog('warn', 'admin.jobsHistory.delete.invalid', { runId: raw });
    response.status(400).json({ error: 'Ungueltige Run-ID (kein gueltiger Categorizer-Run-Ordner).' });
    return;
  }

  if (ingestState.running || aiRescanState.running || scanV2State.running) {
    response.status(409).json({
      error: 'Loeschen nicht moeglich, waehrend ein Scan/KI-Lauf aktiv ist. Bitte warten und erneut versuchen.',
    });
    return;
  }

  const stat = await fsPromises.stat(target).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    response.status(404).json({ error: 'Run nicht gefunden.' });
    return;
  }

  try {
    await fsPromises.rm(target, { recursive: true, force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
    appendBackendDebugLog('error', 'admin.jobsHistory.delete.failed', { runId: raw, error: message });
    response.status(500).json({ error: `Loeschen fehlgeschlagen: ${message}` });
    return;
  }

  appendBackendDebugLog('info', 'admin.jobsHistory.deleted', { runId: raw });
  // Return the refreshed disk-run list so the UI can re-render immediately.
  const diskRuns = await readCategorizerDiskRuns(runRoot);
  response.json({ ok: true, deleted: raw, diskRuns });
});

// /api/admin/ollama/models — short-timeout probe of the local Ollama API.
// Returns { available: false, models: [], error } if Ollama is down — the
// dashboard renders an empty state, never blocks or crashes.
app.get('/api/admin/ollama/models', async (_request, response) => {
  const host = resolveOllamaHost();
  const payload = await probeOllamaModels(host);
  appendBackendDebugLog('info', 'admin.ollamaModels.read', {
    available: payload.available,
    count: payload.models.length,
    host,
  });
  response.json(payload);
});

app.get('/api/admin/ollama/config', (_request, response) => {
  response.json({
    model: resolveOllamaModel(),
    host: resolveOllamaHost(),
    envKey: 'VITE_OLLAMA_MODEL',
  });
});

app.post('/api/admin/ollama/config', async (request, response) => {
  const validation = ollamaModelConfigSchema.safeParse(request.body ?? {});
  if (!validation.success) {
    response.status(400).json({
      error: 'Ungueltiges Modell.',
      details: validation.error.flatten(),
    });
    return;
  }

  const model = validation.data.model;
  try {
    await upsertDotEnvValue('VITE_OLLAMA_MODEL', model);
    process.env.VITE_OLLAMA_MODEL = model;
    appendBackendDebugLog('info', 'admin.ollamaConfig.updated', { model });
    response.json({
      ok: true,
      model,
      host: resolveOllamaHost(),
      envKey: 'VITE_OLLAMA_MODEL',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
    appendBackendDebugLog('error', 'admin.ollamaConfig.updateFailed', { message });
    response.status(500).json({ error: message });
  }
});

// Admin kill-switches for Nutrition/Halal/Allergene (see enrichmentFlags.ts):
// the backend keeps computing all three regardless — this only controls
// whether toApiOffer() includes them in the app-facing /api/offers* response.
// The admin's own KPI coverage percentages (offersQuality.ts) never call
// deriveDealEnrichment with these flags, so they stay accurate either way.
const enrichmentFlagsConfigSchema = z.object({
  nutrition: z.boolean().optional(),
  halal: z.boolean().optional(),
  allergens: z.boolean().optional(),
});

app.get('/api/admin/enrichment-flags', (_request, response) => {
  response.json({ flags: resolveEnrichmentFlags() });
});

app.post('/api/admin/enrichment-flags', async (request, response) => {
  const validation = enrichmentFlagsConfigSchema.safeParse(request.body ?? {});
  if (!validation.success) {
    response.status(400).json({
      error: 'Ungueltige Enrichment-Flags.',
      details: validation.error.flatten(),
    });
    return;
  }

  const updates = validation.data;
  const changed: EnrichmentCategory[] = [];
  try {
    for (const category of ENRICHMENT_CATEGORIES) {
      const value = updates[category];
      if (value === undefined) continue;
      const envKey = enrichmentFlagEnvKey(category);
      await upsertDotEnvValue(envKey, String(value));
      process.env[envKey] = String(value);
      changed.push(category);
    }
    const flags = resolveEnrichmentFlags();
    appendBackendDebugLog('info', 'admin.enrichmentFlags.updated', { changed, flags });
    response.json({ ok: true, flags });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
    appendBackendDebugLog('error', 'admin.enrichmentFlags.updateFailed', { message });
    response.status(500).json({ error: message });
  }
});

// /api/admin/users/events — aggregated subscription/user events. NO PII:
// no emails, no names, no Stripe IDs — only event-type, tier/status,
// timestamps, and a masked user id prefix (`xxxxxxxx…`) for grouping.
app.get('/api/admin/users/events', async (request, response) => {
  const limitParam = Number(request.query.limit ?? 50);
  const limit = Math.max(1, Math.min(200, Number.isFinite(limitParam) ? limitParam : 50));
  try {
    const payload = await getUserEvents(limit);
    appendBackendDebugLog('info', 'admin.userEvents.read', {
      available: payload.available,
      count: payload.events.length,
    });
    response.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
    appendBackendDebugLog('error', 'admin.userEvents.failed', { message });
    response.status(500).json({ error: message });
  }
});

// /api/admin/history — Retention-/Verlaufs-Übersicht für /admin-v2.
// Reines Aggregat aus `public.offer_history` (+ View `offer_history_recent`).
// Keine User-Daten, keine PII — nur Produkt × Store × Zeit-Aggregate.
app.get('/api/admin/history', async (_request, response) => {
  try {
    const payload = await getHistoryStats();
    appendBackendDebugLog('info', 'admin.history.read', {
      available: payload.available,
      totalRows: payload.totalRows,
      topRepeated: payload.topRepeatedProducts.length,
    });
    response.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
    appendBackendDebugLog('error', 'admin.history.failed', { message });
    response.status(500).json({ error: message });
  }
});

// /api/admin/history/runs — Liste der letzten Sync-Runs aus
// public.offer_scan_runs. Limit 50 (max 200 via ?limit). Degradiert sauber
// auf available=false, wenn die Tabelle noch nicht remote ist.
app.get('/api/admin/history/runs', async (request, response) => {
  try {
    const raw = Number((request.query.limit as string | undefined) ?? 50);
    const limit = Number.isFinite(raw) ? raw : 50;
    const payload = await getOfferScanRuns(limit);
    appendBackendDebugLog('info', 'admin.history.runs.read', {
      available: payload.available,
      count: payload.runs.length,
    });
    response.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
    appendBackendDebugLog('error', 'admin.history.runs.failed', { message });
    response.status(500).json({ error: message });
  }
});

// /api/admin/history/weeks — Kalenderwochen-Übersicht für den
// Offer-History-Explorer. Aggregiert verfügbare ISO-KWs aus offer_history
// (paginiert gelesen) + Scan-Run-Zahlen aus offer_scan_runs, falls vorhanden.
// Lädt KEINE Detail-Angebotsliste — das passiert erst beim Klick auf eine KW.
app.get('/api/admin/history/weeks', async (_request, response) => {
  try {
    const payload = await getHistoryWeeks();
    appendBackendDebugLog('info', 'admin.history.weeks.read', {
      available: payload.available,
      weeks: payload.weeks.length,
      scanRunsAvailable: payload.scanRunsAvailable,
    });
    response.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
    appendBackendDebugLog('error', 'admin.history.weeks.failed', { message });
    response.status(500).json({ error: message });
  }
});

// /api/admin/history/week?year=YYYY&week=KW&limit=N — Detail-Angebote einer
// einzelnen ISO-KW, gruppiert nach Produkt × Store. Paginiert/robust gelesen,
// damit die Supabase-1000-Row-Grenze nicht still die Aggregate verfälscht.
app.get('/api/admin/history/week', async (request, response) => {
  try {
    const year = Number((request.query.year as string | undefined) ?? NaN);
    const week = Number((request.query.week as string | undefined) ?? NaN);
    if (!Number.isInteger(year) || !Number.isInteger(week) || week < 1 || week > 53) {
      response
        .status(400)
        .json({ error: 'Parameter year (z. B. 2026) und week (1–53) sind erforderlich.' });
      return;
    }
    const rawLimit = Number((request.query.limit as string | undefined) ?? 200);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 200;
    const payload = await getHistoryWeekDetail({ year, week, limit });
    appendBackendDebugLog('info', 'admin.history.week.read', {
      year,
      week,
      available: payload.available,
      totalGroups: payload.totalGroups,
      returnedGroups: payload.returnedGroups,
    });
    response.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
    appendBackendDebugLog('error', 'admin.history.week.failed', { message });
    response.status(500).json({ error: message });
  }
});

app.post('/api/admin/cache/clear', (_request, response) => {
  clearAdminAggregatorCache();
  appendBackendDebugLog('info', 'admin.cache.cleared');
  response.json({ ok: true, supabaseConfigured: isAdminSupabaseConfigured() });
});

// ── Recipe management (read overview + narrow status/review toggle) ─────────
// Read-only listing + status/review patches only. No delete, no full edit.

app.get('/api/admin/recipes', async (_request, response) => {
  try {
    const payload = await getAdminRecipes();
    appendBackendDebugLog('info', 'admin.recipes.read', {
      available: payload.available,
      total: payload.total,
    });
    response.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
    appendBackendDebugLog('error', 'admin.recipes.failed', { message });
    response.status(500).json({ error: message });
  }
});

app.patch('/api/admin/recipes/:id/status', async (request, response) => {
  if (!isRecipeAdminConfigured()) {
    response.status(503).json({ ok: false, error: 'Supabase nicht konfiguriert.' });
    return;
  }
  const id = String(request.params.id || '');
  const status = String((request.body as { status?: unknown } | undefined)?.status ?? '');
  const result = await updateRecipeStatus(id, status);
  appendBackendDebugLog(result.ok ? 'info' : 'warn', 'admin.recipes.status', {
    id,
    status,
    ok: result.ok,
    error: result.error,
  });
  response.status(result.ok ? 200 : 400).json(result);
});

app.patch('/api/admin/recipes/:id/review', async (request, response) => {
  if (!isRecipeAdminConfigured()) {
    response.status(503).json({ ok: false, error: 'Supabase nicht konfiguriert.' });
    return;
  }
  const id = String(request.params.id || '');
  const verificationStatus = String(
    (request.body as { verification_status?: unknown } | undefined)?.verification_status ?? '',
  );
  const result = await updateRecipeReview(id, verificationStatus);
  appendBackendDebugLog(result.ok ? 'info' : 'warn', 'admin.recipes.review', {
    id,
    verificationStatus,
    ok: result.ok,
    error: result.error,
  });
  response.status(result.ok ? 200 : 400).json(result);
});

app.get('/api/offers/filter-list', (_request, response) => {
  appendBackendDebugLog('info', 'offers.filterList.read');
  response.json({
    filterList: getStrictFoodFilterList(),
  });
});

app.post('/api/offers/filter-list/blocked/add', async (request, response) => {
  const validation = filterKeywordRequestSchema.safeParse(request.body ?? {});
  if (!validation.success) {
    response.status(400).json({
      error: 'Ungueltige Payload.',
      details: validation.error.flatten(),
    });
    return;
  }

  const result = await addStrictBlockedKeyword(validation.data.keyword);
  appendBackendDebugLog('info', 'offers.filterList.blocked.add', {
    keyword: result.keyword,
    changed: result.changed,
  });

  response.json({
    ok: true,
    changed: result.changed,
    keyword: result.keyword,
    filterList: result.list,
  });
});

app.post('/api/offers/filter-list/blocked/remove', async (request, response) => {
  const validation = filterKeywordRequestSchema.safeParse(request.body ?? {});
  if (!validation.success) {
    response.status(400).json({
      error: 'Ungueltige Payload.',
      details: validation.error.flatten(),
    });
    return;
  }

  const result = await removeStrictBlockedKeyword(validation.data.keyword);
  appendBackendDebugLog('info', 'offers.filterList.blocked.remove', {
    keyword: result.keyword,
    changed: result.changed,
  });

  response.json({
    ok: true,
    changed: result.changed,
    keyword: result.keyword,
    filterList: result.list,
  });
});

app.post('/api/offers/filter-list/reset', async (_request, response) => {
  const filterList = await resetStrictFoodFilterRules();
  appendBackendDebugLog('info', 'offers.filterList.reset');

  response.json({
    ok: true,
    filterList,
  });
});

app.post('/api/offers/live-to-filtered', async (request, response) => {
  if (ingestState.running) {
    appendBackendDebugLog('warn', 'offers.liveToFiltered.rejected.running');
    response.status(409).json({
      error: 'Verschieben nicht moeglich waehrend ein Refresh laeuft.',
      ingest: ingestState,
    });
    return;
  }

  const validation = moveOffersRequestSchema.safeParse(request.body ?? {});
  if (!validation.success) {
    response.status(400).json({
      error: 'Ungueltige Payload.',
      details: validation.error.flatten(),
    });
    return;
  }

  const currentMoveResult = moveOffersById(
    snapshot.offers,
    snapshot.filteredOffers,
    validation.data.offerIds,
  );
  const movedFromCurrentIds = new Set(
    currentMoveResult.movedOffers.map((offer) => offer.id),
  );
  const remainingOfferIds = validation.data.offerIds.filter(
    (offerId) => !movedFromCurrentIds.has(offerId),
  );
  const nextWeekMoveResult = moveOffersById(
    snapshot.nextWeekOffers,
    currentMoveResult.nextTarget,
    remainingOfferIds,
  );
  const movedOffers = [
    ...currentMoveResult.movedOffers,
    ...nextWeekMoveResult.movedOffers,
  ];
  const learnedCount = await learnStrictFoodFeedback(
    movedOffers,
    'block',
  );
  snapshot.offers = currentMoveResult.nextSource;
  snapshot.nextWeekOffers = nextWeekMoveResult.nextSource;
  snapshot.filteredOffers = nextWeekMoveResult.nextTarget;
  snapshot.updatedAt = new Date().toISOString();
  await saveSnapshot();

  appendBackendDebugLog('info', 'offers.liveToFiltered.completed', {
    movedCount: movedOffers.length,
    movedFromLiveCount: currentMoveResult.movedCount,
    movedFromNextWeekCount: nextWeekMoveResult.movedCount,
    learnedCount,
    offersCount: snapshot.offers.length,
    nextWeekOffersCount: snapshot.nextWeekOffers.length,
    filteredOffersCount: snapshot.filteredOffers.length,
    liveScopeCounts: countOffersByScope(snapshot.offers),
    nextWeekScopeCounts: countOffersByScope(snapshot.nextWeekOffers),
    filteredScopeCounts: countOffersByScope(snapshot.filteredOffers),
    updatedAt: snapshot.updatedAt,
  });

  response.json({
    ok: true,
    movedCount: movedOffers.length,
    learnedCount,
    offers: snapshot.offers,
    nextWeekOffers: snapshot.nextWeekOffers,
    filteredOffers: snapshot.filteredOffers,
    offerScopes: snapshot.offerScopes,
    scopeSummary: getOfferScopeSummary(),
    updatedAt: snapshot.updatedAt,
    warnings: snapshot.warnings,
    ingest: ingestState,
    system: getManagedProcessStatus(),
  });
});

app.post('/api/offers/filtered-to-live', async (request, response) => {
  if (ingestState.running) {
    appendBackendDebugLog('warn', 'offers.filteredToLive.rejected.running');
    response.status(409).json({
      error: 'Verschieben nicht moeglich waehrend ein Refresh laeuft.',
      ingest: ingestState,
    });
    return;
  }

  const validation = moveOffersRequestSchema.safeParse(request.body ?? {});
  if (!validation.success) {
    response.status(400).json({
      error: 'Ungueltige Payload.',
      details: validation.error.flatten(),
    });
    return;
  }

  const moveResult = moveOffersById(
    snapshot.filteredOffers,
    [],
    validation.data.offerIds,
  );
  const weekSplit = splitOffersByWeek(moveResult.movedOffers);
  const toCurrentWeek = [...weekSplit.current, ...weekSplit.other];
  const learnedCount = await learnStrictFoodFeedback(
    moveResult.movedOffers,
    'allow',
  );
  snapshot.filteredOffers = moveResult.nextSource;
  snapshot.offers = mergeOffersById(snapshot.offers, toCurrentWeek);
  snapshot.nextWeekOffers = mergeOffersById(snapshot.nextWeekOffers, weekSplit.next);
  snapshot.updatedAt = new Date().toISOString();
  await saveSnapshot();

  appendBackendDebugLog('info', 'offers.filteredToLive.completed', {
    movedCount: moveResult.movedCount,
    movedToLiveCount: toCurrentWeek.length,
    movedToNextWeekCount: weekSplit.next.length,
    learnedCount,
    offersCount: snapshot.offers.length,
    nextWeekOffersCount: snapshot.nextWeekOffers.length,
    filteredOffersCount: snapshot.filteredOffers.length,
    liveScopeCounts: countOffersByScope(snapshot.offers),
    nextWeekScopeCounts: countOffersByScope(snapshot.nextWeekOffers),
    filteredScopeCounts: countOffersByScope(snapshot.filteredOffers),
    updatedAt: snapshot.updatedAt,
  });

  response.json({
    ok: true,
    movedCount: moveResult.movedCount,
    learnedCount,
    offers: snapshot.offers,
    nextWeekOffers: snapshot.nextWeekOffers,
    filteredOffers: snapshot.filteredOffers,
    offerScopes: snapshot.offerScopes,
    scopeSummary: getOfferScopeSummary(),
    updatedAt: snapshot.updatedAt,
    warnings: snapshot.warnings,
    ingest: ingestState,
    system: getManagedProcessStatus(),
  });
});

app.post('/api/offers/clear', async (_request, response) => {
  if (ingestState.running) {
    appendBackendDebugLog('warn', 'offers.clear.rejected.running');
    response.status(409).json({
      error: 'Loeschen nicht moeglich waehrend ein Refresh laeuft.',
      ingest: ingestState,
    });
    return;
  }

  const removedCount = snapshot.offers.length;
  const removedNextWeekCount = snapshot.nextWeekOffers.length;
  const removedFilteredCount = snapshot.filteredOffers.length;
  snapshot.offers = [];
  snapshot.nextWeekOffers = [];
  snapshot.filteredOffers = [];
  snapshot.offerScopes = {};
  snapshot.warnings = [];
  snapshot.updatedAt = new Date().toISOString();
  await saveSnapshot();

  appendBackendDebugLog('info', 'offers.clear.completed', {
    removedCount,
    removedNextWeekCount,
    removedFilteredCount,
    scopeSummary: getOfferScopeSummary(),
    updatedAt: snapshot.updatedAt,
  });

  response.json({
    ok: true,
    removedCount,
    removedNextWeekCount,
    removedFilteredCount,
    offers: snapshot.offers,
    nextWeekOffers: snapshot.nextWeekOffers,
    filteredOffers: snapshot.filteredOffers,
    offerScopes: snapshot.offerScopes,
    scopeSummary: getOfferScopeSummary(),
    updatedAt: snapshot.updatedAt,
    warnings: snapshot.warnings,
    ingest: ingestState,
    system: getManagedProcessStatus(),
  });
});

app.post('/api/offers/filter-food', async (_request, response) => {
  if (ingestState.running) {
    appendBackendDebugLog('warn', 'offers.filterFood.rejected.running');
    response.status(409).json({
      error: 'Filtern nicht moeglich waehrend ein Refresh laeuft.',
      ingest: ingestState,
    });
    return;
  }

  const beforeCount = snapshot.offers.length + snapshot.nextWeekOffers.length;
  const strictFilterResult = filterOffersStrictFood([
    ...snapshot.offers,
    ...snapshot.nextWeekOffers,
  ]);
  const strictFilterWarning = createStrictFilterWarning(
    strictFilterResult.removedCount,
    strictFilterResult.removedExamples,
  );

  const weekSplit = applySnapshotWeekSplit(strictFilterResult.offers);
  snapshot.filteredOffers = mergeOffersById(
    snapshot.filteredOffers,
    strictFilterResult.removedOffers,
  );
  snapshot.updatedAt = new Date().toISOString();
  snapshot.warnings = sanitizeWarnings(snapshot.warnings);
  if (strictFilterWarning) {
    snapshot.warnings = [...snapshot.warnings, strictFilterWarning];
  }
  await saveSnapshot();

  appendBackendDebugLog('info', 'offers.filterFood.completed', {
    beforeCount,
    afterCount: snapshot.offers.length,
    nextWeekAfterCount: snapshot.nextWeekOffers.length,
    filteredOffersCount: snapshot.filteredOffers.length,
    removedCount: strictFilterResult.removedCount,
    liveScopeCounts: countOffersByScope(snapshot.offers),
    nextWeekScopeCounts: countOffersByScope(snapshot.nextWeekOffers),
    filteredScopeCounts: countOffersByScope(snapshot.filteredOffers),
    droppedCount: weekSplit.droppedCount,
  });

  response.json({
    ok: true,
    beforeCount,
    removedCount: strictFilterResult.removedCount,
    offers: snapshot.offers,
    nextWeekOffers: snapshot.nextWeekOffers,
    filteredOffers: snapshot.filteredOffers,
    offerScopes: snapshot.offerScopes,
    scopeSummary: getOfferScopeSummary(),
    updatedAt: snapshot.updatedAt,
    warnings: snapshot.warnings,
    ingest: ingestState,
    system: getManagedProcessStatus(),
  });
});

// Rough ETA for a running KI run from elapsed time and processed/total. Returns
// null when there is not yet enough signal (no progress / not running).
function computeAiRescanEta(): { elapsedMs: number; etaSeconds: number | null } | null {
  if (!aiRescanState.running || !aiRescanState.startedAt) return null;
  const elapsedMs = Math.max(0, Date.now() - Date.parse(aiRescanState.startedAt));
  const { processed, total } = aiRescanState;
  if (processed <= 0 || total <= 0 || processed >= total) {
    return { elapsedMs, etaSeconds: null };
  }
  const msPerItem = elapsedMs / processed;
  const etaSeconds = Math.round((msPerItem * (total - processed)) / 1000);
  return { elapsedMs, etaSeconds };
}

app.get('/api/offers/rescan-food-ai/status', async (_request, response) => {
  appendBackendDebugLog('info', 'offers.rescanFoodAi.status.read', {
    running: aiRescanState.running,
    processed: aiRescanState.processed,
    total: aiRescanState.total,
    mode: aiRescanState.mode,
  });
  response.json({
    aiRescan: aiRescanState,
    aiRescanEta: computeAiRescanEta(),
    // Side-by-side comparison KPIs: last full vs. last incremental run.
    aiRescanComparison: lastAiRescanByMode,
    // Ollama runtime so the UI can show external/managed availability up front.
    ollamaRuntime: await getOllamaRuntime(),
    oneClickAi: oneClickAiState,
    ingest: ingestState,
    system: getManagedProcessStatus(),
    updatedAt: snapshot.updatedAt,
    offersCount: snapshot.offers.length,
    nextWeekOffersCount: snapshot.nextWeekOffers.length,
    filteredOffersCount: snapshot.filteredOffers.length,
    scopeSummary: getOfferScopeSummary(),
  });
});

app.post('/api/offers/rescan-food-ai/start', async (request, response) => {
  if (ingestState.running) {
    appendBackendDebugLog('warn', 'offers.rescanFoodAi.start.rejected.running');
    response.status(409).json({
      error: 'KI-Rescan nicht moeglich waehrend ein Refresh laeuft.',
      ingest: ingestState,
      aiRescan: aiRescanState,
    });
    return;
  }

  if (aiRescanState.running || aiRescanBackgroundTask) {
    appendBackendDebugLog('warn', 'offers.rescanFoodAi.start.rejected.active');
    response.status(409).json({
      error: 'KI-Rescan laeuft bereits.',
      aiRescan: aiRescanState,
      ingest: ingestState,
      system: getManagedProcessStatus(),
    });
    return;
  }

  const validation = aiFoodRescanRequestSchema.safeParse(request.body ?? {});
  if (!validation.success) {
    response.status(400).json({
      error: 'Ungueltige Payload.',
      details: validation.error.flatten(),
    });
    return;
  }

  const prepared = prepareAiRescanScope(validation.data.storeChains);
  if (!prepared.ok) {
    appendBackendDebugLog('warn', 'offers.rescanFoodAi.start.rejected.emptyScope', {
      storeChains: validation.data.storeChains,
    });
    response.status(400).json({
      error: prepared.error,
      aiRescan: aiRescanState,
      ingest: ingestState,
    });
    return;
  }
  const sourceOffers = prepared.sourceOffers;
  const scope = prepared.scope;
  const tryOllama = validation.data.tryOllama ?? true;
  const mode = validation.data.mode ?? 'all';
  let preflightWarning: string | null = null;

  // dryRun: compute the plan (candidates/reuse/sent-to-model) and return it.
  // Starts NO Ollama and writes NO snapshot — so a test/probe request can never
  // accidentally trigger a real fallback run that overwrites the snapshot.
  if (validation.data.dryRun === true) {
    const plan = planAiRescan(sourceOffers, mode);
    appendBackendDebugLog('info', 'offers.rescanFoodAi.dryRun', { ...plan });
    response.json({
      ok: true,
      dryRun: true,
      mode,
      plan,
      scopeSummary: getOfferScopeSummary(),
    });
    return;
  }

  // The all-stores guard sizes the run against what would actually hit the
  // model: every offer in classic mode, but only the deduped candidates in
  // incremental mode (so the fast path is not blocked by the full snapshot size).
  const guardOfferCount = planAiRescan(sourceOffers, mode).sentToModel;

  if (tryOllama) {
    const guard = evaluateAllStoresGuard({
      storeChainsCount: scope?.storeChains.length ?? 0,
      sourceOfferCount: guardOfferCount,
      forceAll: validation.data.forceAll === true,
      maxOffers: appConfig.ollamaAllStoresMaxOffers,
    });
    if (!guard.ok) {
      appendBackendDebugLog('warn', 'offers.rescanFoodAi.start.rejected.allStoresGuard', {
        sourceOfferCount: sourceOffers.length,
        maxOffers: appConfig.ollamaAllStoresMaxOffers,
      });
      response.status(guard.status).json({
        error: guard.error,
        requiresForceAll: true,
        aiRescan: aiRescanState,
        ingest: ingestState,
      });
      return;
    }

    const preflight = await ensureScanPreflight(true);
    if (!preflight.ok) {
      response.status(preflight.status).json({
        error: preflight.error,
        reason: preflight.reason,
        aiRescan: aiRescanState,
        ingest: ingestState,
        system: getManagedProcessStatus(),
      });
      return;
    }
    preflightWarning = preflight.warning ?? null;
  }

  aiRescanBackgroundTask = (async () => {
    try {
      const result = await runAiFoodRescanFlow(sourceOffers, tryOllama, scope, mode, preflightWarning, validation.data.model);
      appendBackendDebugLog('info', 'offers.rescanFoodAi.completed', {
        scopeType: scope ? 'stores' : 'all',
        storeChains: scope?.storeChains ?? [],
        sourceCount: sourceOffers.length,
        liveCount: snapshot.offers.length,
        nextWeekCount: snapshot.nextWeekOffers.length,
        filteredCount: snapshot.filteredOffers.length,
        liveScopeCounts: countOffersByScope(snapshot.offers),
        nextWeekScopeCounts: countOffersByScope(snapshot.nextWeekOffers),
        filteredScopeCounts: countOffersByScope(snapshot.filteredOffers),
        aiClassifiedCount: result.aiClassifiedCount,
        fallbackCount: result.fallbackCount,
        updatedAt: snapshot.updatedAt,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unbekannter KI-Rescan-Fehler';
      appendBackendDebugLog('error', 'offers.rescanFoodAi.failed', { message });
    } finally {
      aiRescanBackgroundTask = null;
    }
  })();

  response.status(202).json({
    ok: true,
    message: 'KI-Rescan wurde gestartet.',
    aiRescan: aiRescanState,
    ingest: ingestState,
    system: getManagedProcessStatus(),
    scopeSummary: getOfferScopeSummary(),
  });
});

app.post('/api/offers/rescan-food-ai', async (request, response) => {
  if (ingestState.running) {
    appendBackendDebugLog('warn', 'offers.rescanFoodAi.rejected.running');
    response.status(409).json({
      error: 'KI-Rescan nicht moeglich waehrend ein Refresh laeuft.',
      ingest: ingestState,
      aiRescan: aiRescanState,
    });
    return;
  }

  if (aiRescanState.running) {
    appendBackendDebugLog('warn', 'offers.rescanFoodAi.rejected.active');
    response.status(409).json({
      error: 'KI-Rescan laeuft bereits.',
      aiRescan: aiRescanState,
      ingest: ingestState,
      system: getManagedProcessStatus(),
    });
    return;
  }

  const validation = aiFoodRescanRequestSchema.safeParse(request.body ?? {});
  if (!validation.success) {
    response.status(400).json({
      error: 'Ungueltige Payload.',
      details: validation.error.flatten(),
    });
    return;
  }

  const prepared = prepareAiRescanScope(validation.data.storeChains);
  if (!prepared.ok) {
    appendBackendDebugLog('warn', 'offers.rescanFoodAi.rejected.emptyScope', {
      storeChains: validation.data.storeChains,
    });
    response.status(400).json({
      error: prepared.error,
      aiRescan: aiRescanState,
      ingest: ingestState,
    });
    return;
  }
  const sourceOffers = prepared.sourceOffers;
  const scope = prepared.scope;
  const tryOllama = validation.data.tryOllama ?? true;
  const mode = validation.data.mode ?? 'all';
  let preflightWarning: string | null = null;

  // dryRun: compute the plan (candidates/reuse/sent-to-model) and return it.
  // Starts NO Ollama and writes NO snapshot — so a test/probe request can never
  // accidentally trigger a real fallback run that overwrites the snapshot.
  if (validation.data.dryRun === true) {
    const plan = planAiRescan(sourceOffers, mode);
    appendBackendDebugLog('info', 'offers.rescanFoodAi.dryRun', { ...plan });
    response.json({
      ok: true,
      dryRun: true,
      mode,
      plan,
      scopeSummary: getOfferScopeSummary(),
    });
    return;
  }

  // The all-stores guard sizes the run against what would actually hit the
  // model: every offer in classic mode, but only the deduped candidates in
  // incremental mode (so the fast path is not blocked by the full snapshot size).
  const guardOfferCount = planAiRescan(sourceOffers, mode).sentToModel;

  if (tryOllama) {
    const guard = evaluateAllStoresGuard({
      storeChainsCount: scope?.storeChains.length ?? 0,
      sourceOfferCount: guardOfferCount,
      forceAll: validation.data.forceAll === true,
      maxOffers: appConfig.ollamaAllStoresMaxOffers,
    });
    if (!guard.ok) {
      appendBackendDebugLog('warn', 'offers.rescanFoodAi.rejected.allStoresGuard', {
        sourceOfferCount: sourceOffers.length,
        maxOffers: appConfig.ollamaAllStoresMaxOffers,
      });
      response.status(guard.status).json({
        error: guard.error,
        requiresForceAll: true,
        aiRescan: aiRescanState,
        ingest: ingestState,
      });
      return;
    }

    const preflight = await ensureScanPreflight(true);
    if (!preflight.ok) {
      response.status(preflight.status).json({
        error: preflight.error,
        reason: preflight.reason,
        aiRescan: aiRescanState,
        ingest: ingestState,
        system: getManagedProcessStatus(),
      });
      return;
    }
    preflightWarning = preflight.warning ?? null;
  }

  try {
    const rescan = await runAiFoodRescanFlow(sourceOffers, tryOllama, scope, mode, preflightWarning, validation.data.model);

    appendBackendDebugLog('info', 'offers.rescanFoodAi.completed.sync', {
      scopeType: scope ? 'stores' : 'all',
      storeChains: scope?.storeChains ?? [],
      sourceCount: sourceOffers.length,
      liveCount: snapshot.offers.length,
      nextWeekCount: snapshot.nextWeekOffers.length,
      filteredCount: snapshot.filteredOffers.length,
      liveScopeCounts: countOffersByScope(snapshot.offers),
      nextWeekScopeCounts: countOffersByScope(snapshot.nextWeekOffers),
      filteredScopeCounts: countOffersByScope(snapshot.filteredOffers),
      aiClassifiedCount: rescan.aiClassifiedCount,
      fallbackCount: rescan.fallbackCount,
      updatedAt: snapshot.updatedAt,
    });

    response.json({
      ok: true,
      scannedCount: rescan.scannedCount,
      aiClassifiedCount: rescan.aiClassifiedCount,
      fallbackCount: rescan.fallbackCount,
      offers: snapshot.offers,
      nextWeekOffers: snapshot.nextWeekOffers,
      filteredOffers: snapshot.filteredOffers,
      offerScopes: snapshot.offerScopes,
      scopeSummary: getOfferScopeSummary(),
      updatedAt: snapshot.updatedAt,
      warnings: snapshot.warnings,
      ingest: ingestState,
      aiRescan: aiRescanState,
      system: getManagedProcessStatus(),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unbekannter KI-Rescan-Fehler';
    appendBackendDebugLog('error', 'offers.rescanFoodAi.failed.sync', { message });
    response.status(502).json({
      error: message,
      ingest: ingestState,
      aiRescan: aiRescanState,
      system: getManagedProcessStatus(),
    });
  }
});

// Hard cancel for a running KI-Rescan: aborts the Python child (not just the UI
// flag) and leaves the snapshot untouched. The background flow's catch turns
// the PipelineCancelledError into a "Vom Nutzer abgebrochen" state.
app.post('/api/offers/rescan-food-ai/cancel', (_request, response) => {
  if (!aiRescanState.running && !aiRescanBackgroundTask && !aiRescanAbortController) {
    response.status(409).json({
      error: 'Kein KI-Rescan aktiv, der abgebrochen werden koennte.',
      aiRescan: aiRescanState,
    });
    return;
  }
  aiRescanState.message = 'KI-Lauf wird abgebrochen…';
  aiRescanAbortController?.abort();
  appendBackendDebugLog('info', 'offers.rescanFoodAi.cancelRequested', {
    hadController: Boolean(aiRescanAbortController),
  });
  response.status(202).json({
    ok: true,
    message: 'Abbruch angefordert. Der laufende KI-Prozess wird beendet.',
    aiRescan: aiRescanState,
  });
});

app.post('/api/offers/refresh', async (request, response) => {
  if (ingestState.running) {
    appendBackendDebugLog('warn', 'offers.refresh.rejected.running');
    response.status(409).json({
      error: 'Ein Refresh laeuft bereits.',
      ingest: ingestState,
    });
    return;
  }

  const validation = refreshRequestSchema.safeParse(request.body ?? {});
  if (!validation.success) {
    appendBackendDebugLog('warn', 'offers.refresh.invalidPayload', {
      issues: validation.error.issues.map((issue) => issue.message),
    });
    response.status(400).json({
      error: 'Ungueltige Refresh-Payload.',
      details: validation.error.flatten(),
    });
    return;
  }

  const locationFilter = validation.data.locationFilter ?? defaultLocationFilter;
  const tryOllama = validation.data.tryOllama ?? true;
  const enrichWithOllama = validation.data.enrichWithOllama ?? tryOllama;

  appendBackendDebugLog('info', 'offers.refresh.started', {
    locationFilter,
    tryOllama,
    enrichWithOllama,
  });

  ingestState.running = true;
  ingestState.startedAt = new Date().toISOString();
  ingestState.finishedAt = null;
  ingestState.lastError = null;
  ingestState.message = 'Ingest gestartet.';

  try {
    const scopedIngest = await runNationalAndLocalIngest({
      locationFilter,
      tryOllama,
      onProgress: (scope, message, total, completed) => {
        const scopeLabel = scope === 'national' ? 'National' : 'Lokal';
        if (total && completed) {
          ingestState.message = `${scopeLabel}: ${message} (${completed}/${total})`;
          return;
        }
        ingestState.message = `${scopeLabel}: ${message}`;
      },
    });

    const categorization = await runOffersCategorizerPipeline(scopedIngest.offers, {
      tryOllama: tryOllama && enrichWithOllama,
      mode: appConfig.offerWeekMode,
      onProgress: (progress) => {
        ingestState.message = `Kategorie-Pipeline: ${progress.processed}/${progress.total}`;
      },
    });

    const combinedWarnings = sanitizeWarnings([
      ...scopedIngest.warnings,
      ...categorization.warnings,
    ]);
    if (categorization.reviewNeededCount > 0) {
      combinedWarnings.push(
        `Hinweis: ${categorization.reviewNeededCount} Angebot(e) brauchen Review (niedrige KI-Sicherheit).`,
      );
    }

    snapshot.offerScopes = scopedIngest.offerScopes;
    const weekSplit = applyCategorizedOffersToSnapshot(categorization);
    snapshot.warnings = combinedWarnings;
    if (weekSplit.strictRemovedCount > 0) {
      snapshot.warnings = [
        ...snapshot.warnings,
        `Strenger Lebensmittel-Filter: ${weekSplit.strictRemovedCount} Nicht-Lebensmittel entfernt. Beispiele: ${weekSplit.strictRemovedExamples.join(', ')}`,
      ];
    }
    if (weekSplit.droppedCount > 0) {
      snapshot.warnings = [
        ...snapshot.warnings,
        `Hinweis: ${weekSplit.droppedCount} Angebot(e) wurden verworfen (weder diese noch naechste Woche).`,
      ];
    }
    snapshot.updatedAt = new Date().toISOString();
    await saveSnapshot();

    appendBackendDebugLog('info', 'offers.refresh.completed', {
      offersCount: snapshot.offers.length,
      nextWeekOffersCount: snapshot.nextWeekOffers.length,
      filteredOffersCount: snapshot.filteredOffers.length,
      warningsCount: snapshot.warnings.length,
      filteredOutNonFoodCount: snapshot.filteredOffers.length,
      sourceCounts: scopedIngest.sourceCounts,
      liveScopeCounts: countOffersByScope(snapshot.offers),
      nextWeekScopeCounts: countOffersByScope(snapshot.nextWeekOffers),
      filteredScopeCounts: countOffersByScope(snapshot.filteredOffers),
      droppedCount: weekSplit.droppedCount,
      aiClassifiedCount: categorization.aiClassifiedCount,
      fallbackCount: categorization.fallbackCount,
      updatedAt: snapshot.updatedAt,
    });

    ingestState.running = false;
    ingestState.finishedAt = new Date().toISOString();
    ingestState.message = `Fertig: ${snapshot.offers.length} Live + ${snapshot.nextWeekOffers.length} Naechste-Woche.`;

    response.json({
      offers: serializeOffersForApi(snapshot.offers),
      nextWeekOffers: serializeOffersForApi(snapshot.nextWeekOffers),
      filteredOffers: serializeOffersForApi(snapshot.filteredOffers),
      offerScopes: snapshot.offerScopes,
      scopeSummary: getOfferScopeSummary(),
      updatedAt: snapshot.updatedAt,
      warnings: snapshot.warnings,
      ingest: ingestState,
      system: getManagedProcessStatus(),
    });
  } catch (error) {
    ingestState.running = false;
    ingestState.finishedAt = new Date().toISOString();
    ingestState.message = 'Ingest fehlgeschlagen.';
    ingestState.lastError =
      error instanceof Error ? error.message : 'Unbekannter Backend-Fehler';

    appendBackendDebugLog('error', 'offers.refresh.failed', {
      error: ingestState.lastError,
    });

    response.status(500).json({
      error: ingestState.lastError,
      ingest: ingestState,
      system: getManagedProcessStatus(),
    });
  }
});

app.post('/api/offers/one-click-sync', async (_request, response) => {
  if (ingestState.running) {
    appendBackendDebugLog('warn', 'offers.oneClick.rejected.running');
    response.status(409).json({
      error: 'One-Click nicht moeglich waehrend ein Refresh laeuft.',
      ingest: ingestState,
    });
    return;
  }

  const removedCount = snapshot.offers.length;
  const removedNextWeekCount = snapshot.nextWeekOffers.length;
  const removedFilteredCount = snapshot.filteredOffers.length;
  snapshot.offers = [];
  snapshot.nextWeekOffers = [];
  snapshot.filteredOffers = [];
  snapshot.offerScopes = {};
  snapshot.warnings = [];
  snapshot.updatedAt = new Date().toISOString();
  await saveSnapshot();

  appendBackendDebugLog('info', 'offers.oneClick.cleared', {
    removedCount,
    removedNextWeekCount,
    removedFilteredCount,
    updatedAt: snapshot.updatedAt,
  });

  ingestState.running = true;
  ingestState.startedAt = new Date().toISOString();
  ingestState.finishedAt = null;
  ingestState.lastError = null;
  ingestState.message = 'One-Click: Ermittlung gestartet.';

  try {
    const scopedIngest = await runNationalAndLocalIngest({
      locationFilter: defaultLocationFilter,
      tryOllama: true,
      onProgress: (scope, message, total, completed) => {
        const scopeLabel = scope === 'national' ? 'National' : 'Lokal';
        if (total && completed) {
          ingestState.message = `One-Click ${scopeLabel}: ${message} (${completed}/${total})`;
          return;
        }
        ingestState.message = `One-Click ${scopeLabel}: ${message}`;
      },
    });

    const categorization = await runOffersCategorizerPipeline(scopedIngest.offers, {
      tryOllama: true,
      mode: appConfig.offerWeekMode,
      onProgress: (progress) => {
        ingestState.message = `One-Click Kategorie-Pipeline: ${progress.processed}/${progress.total}`;
      },
    });

    const combinedWarnings = sanitizeWarnings([
      ...scopedIngest.warnings,
      ...categorization.warnings,
    ]);
    if (categorization.reviewNeededCount > 0) {
      combinedWarnings.push(
        `Hinweis: ${categorization.reviewNeededCount} Angebot(e) brauchen Review (niedrige KI-Sicherheit).`,
      );
    }

    snapshot.offerScopes = scopedIngest.offerScopes;
    const weekSplit = applyCategorizedOffersToSnapshot(categorization);
    snapshot.warnings = combinedWarnings;
    if (weekSplit.strictRemovedCount > 0) {
      snapshot.warnings = [
        ...snapshot.warnings,
        `Strenger Lebensmittel-Filter: ${weekSplit.strictRemovedCount} Nicht-Lebensmittel entfernt. Beispiele: ${weekSplit.strictRemovedExamples.join(', ')}`,
      ];
    }
    if (weekSplit.droppedCount > 0) {
      snapshot.warnings = [
        ...snapshot.warnings,
        `Hinweis: ${weekSplit.droppedCount} Angebot(e) wurden verworfen (weder diese noch naechste Woche).`,
      ];
    }
    snapshot.updatedAt = new Date().toISOString();
    await saveSnapshot();

    ingestState.running = false;
    ingestState.finishedAt = new Date().toISOString();
    ingestState.message = `One-Click fertig: ${snapshot.offers.length} Live + ${snapshot.nextWeekOffers.length} Naechste-Woche.`;

    appendBackendDebugLog('info', 'offers.oneClick.completed', {
      offersCount: snapshot.offers.length,
      nextWeekOffersCount: snapshot.nextWeekOffers.length,
      filteredOffersCount: snapshot.filteredOffers.length,
      warningsCount: snapshot.warnings.length,
      filteredOutNonFoodCount: snapshot.filteredOffers.length,
      sourceCounts: scopedIngest.sourceCounts,
      liveScopeCounts: countOffersByScope(snapshot.offers),
      nextWeekScopeCounts: countOffersByScope(snapshot.nextWeekOffers),
      filteredScopeCounts: countOffersByScope(snapshot.filteredOffers),
      droppedCount: weekSplit.droppedCount,
      aiClassifiedCount: categorization.aiClassifiedCount,
      fallbackCount: categorization.fallbackCount,
      updatedAt: snapshot.updatedAt,
    });

    response.json({
      ok: true,
      removedCount,
      removedNextWeekCount,
      removedFilteredCount,
      offers: snapshot.offers,
      nextWeekOffers: snapshot.nextWeekOffers,
      filteredOffers: snapshot.filteredOffers,
      offerScopes: snapshot.offerScopes,
      scopeSummary: getOfferScopeSummary(),
      updatedAt: snapshot.updatedAt,
      warnings: snapshot.warnings,
      ingest: ingestState,
      system: getManagedProcessStatus(),
    });
  } catch (error) {
    ingestState.running = false;
    ingestState.finishedAt = new Date().toISOString();
    ingestState.message = 'One-Click fehlgeschlagen.';
    ingestState.lastError =
      error instanceof Error ? error.message : 'Unbekannter One-Click-Fehler';

    appendBackendDebugLog('error', 'offers.oneClick.failed', {
      error: ingestState.lastError,
    });

    response.status(500).json({
      error: ingestState.lastError,
      ingest: ingestState,
      system: getManagedProcessStatus(),
    });
  }
});

app.get('/api/offers/one-click-ai-live/status', (_request, response) => {
  appendBackendDebugLog('info', 'offers.oneClickAi.status.read', {
    running: oneClickAiState.running,
    stage: oneClickAiState.stage,
    processed: oneClickAiState.processed,
    total: oneClickAiState.total,
    scopeSummary: getOfferScopeSummary(),
  });
  response.json({
    oneClickAi: oneClickAiState,
    ingest: ingestState,
    aiRescan: aiRescanState,
    system: getManagedProcessStatus(),
    updatedAt: snapshot.updatedAt,
    offersCount: snapshot.offers.length,
    nextWeekOffersCount: snapshot.nextWeekOffers.length,
    filteredOffersCount: snapshot.filteredOffers.length,
    scopeSummary: getOfferScopeSummary(),
  });
});

app.post('/api/offers/one-click-ai-live/start', async (request, response) => {
  const prep = await prepareOneClickAiStart(request.body);
  if (!prep.ok) {
    appendBackendDebugLog('warn', 'offers.oneClickAi.start.rejected', {
      reason: prep.error,
    });
    response.status(prep.status).json({
      error: prep.error,
      requiresForceAll: prep.requiresForceAll,
      reason: prep.reason,
      oneClickAi: oneClickAiState,
      ingest: ingestState,
      aiRescan: aiRescanState,
      system: getManagedProcessStatus(),
    });
    return;
  }

  startOneClickAiBackground();
  appendBackendDebugLog('info', 'offers.oneClickAi.start.accepted');

  response.status(202).json({
    ok: true,
    message: 'One-Click-KI gestartet.',
    oneClickAi: oneClickAiState,
    ingest: ingestState,
    aiRescan: aiRescanState,
    system: getManagedProcessStatus(),
    scopeSummary: getOfferScopeSummary(),
  });
});

app.post('/api/offers/one-click-ai-live', async (request, response) => {
  const prep = await prepareOneClickAiStart(request.body);
  if (!prep.ok) {
    appendBackendDebugLog('warn', 'offers.oneClickAi.legacy.rejected', {
      reason: prep.error,
    });
    response.status(prep.status).json({
      error: prep.error,
      requiresForceAll: prep.requiresForceAll,
      reason: prep.reason,
      oneClickAi: oneClickAiState,
      ingest: ingestState,
      aiRescan: aiRescanState,
      system: getManagedProcessStatus(),
    });
    return;
  }

  startOneClickAiBackground();
  appendBackendDebugLog('info', 'offers.oneClickAi.legacy.accepted');
  response.status(202).json({
    ok: true,
    message: 'One-Click-KI gestartet.',
    oneClickAi: oneClickAiState,
    ingest: ingestState,
    aiRescan: aiRescanState,
    system: getManagedProcessStatus(),
    scopeSummary: getOfferScopeSummary(),
  });
});

// Hard cancel for a running One-Click-KI run. Aborts the category-pipeline child
// once it is running; the heavy phase is the KI pipeline, so this terminates the
// long-running work. (A cancel during the brief pre-pipeline ingest phase only
// flips the message — there is no child to kill yet.)
app.post('/api/offers/one-click-ai-live/cancel', (_request, response) => {
  if (!oneClickAiState.running && !oneClickAiBackgroundTask) {
    response.status(409).json({
      error: 'Kein One-Click-KI-Lauf aktiv, der abgebrochen werden koennte.',
      oneClickAi: oneClickAiState,
    });
    return;
  }
  oneClickAiState.message = 'One-Click-KI wird abgebrochen…';
  oneClickAiAbortController?.abort();
  appendBackendDebugLog('info', 'offers.oneClickAi.cancelRequested', {
    hadController: Boolean(oneClickAiAbortController),
  });
  response.status(202).json({
    ok: true,
    message: 'Abbruch angefordert.',
    oneClickAi: oneClickAiState,
  });
});

// ─── Wochen-Auto-Scan Endpunkte ────────────────────────────────────────────
app.get('/api/offers/weekly-auto-scan/status', (_request, response) => {
  response.json({
    weeklyScan: weeklyScanState,
    config: {
      enabled: appConfig.weeklyScanEnabled,
      day: appConfig.weeklyScanDay,
      time: appConfig.weeklyScanTime,
      excludedStores: parseExcludedStores(appConfig.weeklyScanExcludedStores),
      aiMode: appConfig.weeklyScanAiMode,
      forceAll: appConfig.weeklyScanForceAll,
      autoSync: appConfig.weeklyScanAutoSync,
      lastTriggeredAt: weeklyScanLastTriggeredIso,
    },
    ingest: ingestState,
    aiRescan: aiRescanState,
    system: getManagedProcessStatus(),
    updatedAt: snapshot.updatedAt,
    offersCount: snapshot.offers.length,
    nextWeekOffersCount: snapshot.nextWeekOffers.length,
    filteredOffersCount: snapshot.filteredOffers.length,
  });
});

app.post('/api/offers/weekly-auto-scan/start', (_request, response) => {
  const allowed = canStartWeeklyScan();
  if (!allowed.ok) {
    appendBackendDebugLog('warn', 'offers.weeklyAutoScan.start.rejected', { reason: allowed.error });
    response.status(allowed.status).json({
      error: allowed.error,
      weeklyScan: weeklyScanState,
      ingest: ingestState,
    });
    return;
  }
  // Auto-Modus sendet intern bewusst forceAll — KEIN forceAll-Guard hier.
  startWeeklyAutoScanBackground('manual');
  appendBackendDebugLog('info', 'offers.weeklyAutoScan.start.accepted', {});
  response.status(202).json({
    ok: true,
    message: 'Wochen-Auto-Scan gestartet.',
    weeklyScan: weeklyScanState,
    ingest: ingestState,
    system: getManagedProcessStatus(),
  });
});

app.post('/api/offers/weekly-auto-scan/cancel', (_request, response) => {
  if (!weeklyScanState.running && !weeklyScanBackgroundTask) {
    response.status(409).json({
      error: 'Kein Wochen-Auto-Scan aktiv, der abgebrochen werden koennte.',
      weeklyScan: weeklyScanState,
    });
    return;
  }
  weeklyScanState.message = 'Wochen-Auto-Scan wird abgebrochen…';
  weeklyScanAbortController?.abort();
  appendBackendDebugLog('info', 'offers.weeklyAutoScan.cancelRequested', {
    hadController: Boolean(weeklyScanAbortController),
  });
  response.status(202).json({
    ok: true,
    message: 'Abbruch angefordert. Der laufende KI-Prozess wird beendet.',
    weeklyScan: weeklyScanState,
  });
});

// ─── Angebots-Scan 2.0 Endpunkte ────────────────────────────────────────────
const scanV2StartSchema = z.object({
  mode: z.string().trim().min(1).optional(),
  forceAll: z.boolean().optional(),
  // Verwirf einen vorhandenen Pause-Checkpoint und starte frisch (statt 409).
  overwriteCheckpoint: z.boolean().optional(),
});

function scanV2StatusPayload(): Record<string, unknown> {
  return {
    scanV2: scanV2State,
    ingest: ingestState,
    // Schlanke Checkpoint-Meta (ohne die großen Angebots-Arrays) für die UI:
    // ist ein Resume möglich, in welcher Phase, bei welchem Fortschritt.
    checkpoint: scanV2CheckpointMeta,
    updatedAt: snapshot.updatedAt,
    offersCount: snapshot.offers.length,
    nextWeekOffersCount: snapshot.nextWeekOffers.length,
    filteredOffersCount: snapshot.filteredOffers.length,
    system: getManagedProcessStatus(),
  };
}

app.get('/api/offers/scan-v2/status', (_request, response) => {
  response.json(scanV2StatusPayload());
});

app.post('/api/offers/scan-v2/start', async (request, response) => {
  const validation = scanV2StartSchema.safeParse(request.body ?? {});
  if (!validation.success) {
    response.status(400).json({
      error: 'Ungueltige Scan-2.0-Payload.',
      details: validation.error.flatten(),
    });
    return;
  }

  // Default: Phase 1 + danach automatisch Phase 2 (Hauptbutton-Verhalten).
  const mode = parseScanV2Mode(validation.data.mode ?? 'phase1_phase2');
  if (!mode) {
    response.status(400).json({
      error: 'Ungueltiger mode. Erlaubt: phase1 | phase2 | phase1_phase2.',
    });
    return;
  }

  const allowed = canStartScanV2();
  if (!allowed.ok) {
    appendBackendDebugLog('warn', 'offers.scanV2.start.rejected', { reason: allowed.error, mode });
    response.status(allowed.status).json({
      error: allowed.error,
      ...scanV2StatusPayload(),
    });
    return;
  }

  // Robuste, einfache Variante: Ein vorhandener Pause-Checkpoint blockiert einen
  // frischen Start. Der Nutzer muss bewusst /resume (fortsetzen) ODER
  // /clear-checkpoint bzw. overwriteCheckpoint:true (verwerfen) wählen.
  const overwriteCheckpoint = validation.data.overwriteCheckpoint === true;
  if (scanV2CheckpointMeta && !overwriteCheckpoint) {
    appendBackendDebugLog('warn', 'offers.scanV2.start.checkpointPresent', { mode });
    response.status(409).json({
      error:
        'Checkpoint vorhanden. /api/offers/scan-v2/resume zum Fortsetzen, oder ' +
        '/api/offers/scan-v2/clear-checkpoint (bzw. overwriteCheckpoint:true) zum Verwerfen.',
      ...scanV2StatusPayload(),
    });
    return;
  }
  if (overwriteCheckpoint) {
    await discardScanV2Checkpoint().catch(() => undefined);
  }

  const forceAll = validation.data.forceAll === true;
  startScanV2Background(mode, forceAll);
  appendBackendDebugLog('info', 'offers.scanV2.start.accepted', { mode, forceAll, overwriteCheckpoint });
  response.status(202).json({
    ok: true,
    message: `Angebots-Scan 2.0 (${mode}) gestartet.`,
    ...scanV2StatusPayload(),
  });
});

app.post('/api/offers/scan-v2/pause', (_request, response) => {
  if (!scanV2State.running || !scanV2BackgroundTask) {
    response.status(409).json({
      error: 'Kein laufender Angebots-Scan 2.0, der pausiert werden koennte.',
      ...scanV2StatusPayload(),
    });
    return;
  }
  if (scanV2PauseRequested) {
    response.status(202).json({
      ok: true,
      message: 'Pause ist bereits angefordert.',
      ...scanV2StatusPayload(),
    });
    return;
  }
  // Pause ist KEIN Cancel: der aktuelle Batch wird unterbrochen, aber der bis
  // dahin persistierte Checkpoint bleibt erhalten. Resume setzt dort fort.
  scanV2PauseRequested = true;
  scanV2State.message = 'Angebots-Scan 2.0 wird pausiert (Fortschritt wird gesichert)…';
  scanV2AbortController?.abort();
  appendBackendDebugLog('info', 'offers.scanV2.pauseRequested', {
    processed: scanV2State.processed, total: scanV2State.total,
  });
  response.status(202).json({
    ok: true,
    message: 'Pause angefordert. Der Checkpoint wird gesichert.',
    ...scanV2StatusPayload(),
  });
});

app.post('/api/offers/scan-v2/resume', async (_request, response) => {
  const allowed = canStartScanV2();
  if (!allowed.ok) {
    response.status(allowed.status).json({ error: allowed.error, ...scanV2StatusPayload() });
    return;
  }

  let checkpoint: ScanV2Checkpoint | null;
  try {
    checkpoint = await readCheckpoint(SCAN_V2_CHECKPOINT_FILE);
  } catch (error) {
    if (error instanceof CheckpointCorruptError) {
      appendBackendDebugLog('error', 'offers.scanV2.resume.corrupt', { error: error.message });
      response.status(422).json({
        error: `Checkpoint beschädigt — Resume nicht möglich. ${error.message} ` +
          '/clear-checkpoint zum Verwerfen.',
        ...scanV2StatusPayload(),
      });
      return;
    }
    throw error;
  }
  if (!checkpoint) {
    response.status(409).json({
      error: 'Kein Checkpoint vorhanden — es gibt nichts fortzusetzen.',
      ...scanV2StatusPayload(),
    });
    return;
  }

  // Defensive: ein alter Checkpoint ohne ableitbaren Scope wird NICHT auf "alle
  // Shops" geraten — ehrlicher Abbruch (kontrolliert), bevor der Lauf startet.
  const resumeScope = resolveCheckpointScope(checkpoint);
  if ('error' in resumeScope) {
    appendBackendDebugLog('error', 'offers.scanV2.resume.scopeUnclear', { error: resumeScope.error });
    response.status(422).json({ error: resumeScope.error, ...scanV2StatusPayload() });
    return;
  }

  // Mirror the on-disk meta into memory so the status immediately shows resuming.
  scanV2CheckpointMeta = summarizeCheckpoint(checkpoint);
  startScanV2Background(checkpoint.mode, false, checkpoint);
  appendBackendDebugLog('info', 'offers.scanV2.resume.accepted', {
    mode: checkpoint.mode, phase: checkpoint.phase, processed: checkpoint.processed, total: checkpoint.total,
  });
  response.status(202).json({
    ok: true,
    message: `Angebots-Scan 2.0 (${checkpoint.mode}) wird ab ${checkpoint.processed}/${checkpoint.total} fortgesetzt.`,
    ...scanV2StatusPayload(),
  });
});

app.post('/api/offers/scan-v2/clear-checkpoint', async (_request, response) => {
  if (scanV2State.running || scanV2BackgroundTask) {
    response.status(409).json({
      error: 'Angebots-Scan 2.0 läuft — Checkpoint kann nicht gelöscht werden (erst pausieren/abbrechen).',
      ...scanV2StatusPayload(),
    });
    return;
  }
  await discardScanV2Checkpoint();
  if (scanV2State.paused || scanV2State.phase === 'paused') {
    scanV2State.paused = false;
    scanV2State.phase = 'idle';
    scanV2State.pausedAt = null;
    scanV2State.message = 'Checkpoint gelöscht. Kein Resume mehr möglich.';
  }
  appendBackendDebugLog('info', 'offers.scanV2.checkpoint.cleared', {});
  response.json({ ok: true, message: 'Checkpoint gelöscht.', ...scanV2StatusPayload() });
});

app.post('/api/offers/scan-v2/cancel', async (_request, response) => {
  if (scanV2State.running || scanV2BackgroundTask) {
    // Laufenden Scan abbrechen. pauseRequested zurücksetzen, damit der Abort als
    // Cancel (Checkpoint verwerfen) und nicht als Pause behandelt wird.
    scanV2PauseRequested = false;
    scanV2State.message = 'Angebots-Scan 2.0 wird abgebrochen…';
    scanV2AbortController?.abort();
    appendBackendDebugLog('info', 'offers.scanV2.cancelRequested', {
      hadController: Boolean(scanV2AbortController),
    });
    response.status(202).json({
      ok: true,
      message: 'Abbruch angefordert. Checkpoint wird verworfen, Phase-1-Daten bleiben erhalten.',
      ...scanV2StatusPayload(),
    });
    return;
  }
  // Pausierten Scan abbrechen (kein laufender Task): Checkpoint verwerfen.
  if (scanV2State.paused || scanV2CheckpointMeta) {
    await discardScanV2Checkpoint();
    scanV2State.paused = false;
    scanV2State.phase = 'cancelled';
    scanV2State.pausedAt = null;
    scanV2State.message = 'Pausierter Angebots-Scan 2.0 abgebrochen — Checkpoint verworfen.';
    appendBackendDebugLog('info', 'offers.scanV2.cancelPaused', {});
    response.status(202).json({
      ok: true,
      message: 'Pausierter Scan abgebrochen, Checkpoint verworfen.',
      ...scanV2StatusPayload(),
    });
    return;
  }
  response.status(409).json({
    error: 'Kein Angebots-Scan 2.0 aktiv, der abgebrochen werden koennte.',
    ...scanV2StatusPayload(),
  });
});

app.get('/api/system/status', async (_request, response) => {
  appendBackendDebugLog('info', 'system.status.read');
  response.json({
    system: getManagedProcessStatus(),
    ollamaRuntime: await getOllamaRuntime(),
    ollamaPull: getOllamaPullStatus(),
    aiRescan: aiRescanState,
    oneClickAi: oneClickAiState,
  });
});

app.get('/api/system/ollama/pull-status', (_request, response) => {
  appendBackendDebugLog('info', 'system.ollamaPull.status.read');
  response.json({
    ollamaPull: getOllamaPullStatus(),
    system: getManagedProcessStatus(),
    aiRescan: aiRescanState,
    oneClickAi: oneClickAiState,
  });
});

app.post('/api/system/ollama/pull', async (request, response) => {
  const validation = ollamaPullRequestSchema.safeParse(request.body ?? {});
  if (!validation.success) {
    response.status(400).json({
      error: 'Ungueltige Payload.',
      details: validation.error.flatten(),
    });
    return;
  }

  const model = validation.data.model ?? resolveOllamaModel();
  const ollamaState = startManagedProcess('ollama');
  appendBackendDebugLog('info', 'system.ollamaPull.requested', {
    model,
    ollamaRunning: ollamaState.running,
    ollamaPid: ollamaState.pid,
  });

  const ready = await ensureOllamaReady(8000);
  const pullState = startOllamaPull(model);

  if (!pullState.running && pullState.lastError) {
    response.status(502).json({
      error: pullState.lastError,
      model,
      ollamaReady: ready,
      ollamaPull: pullState,
      system: getManagedProcessStatus(),
    });
    return;
  }

  response.status(202).json({
    ok: true,
    message: `Ollama pull fuer Modell "${model}" gestartet.`,
    model,
    ollamaReady: ready,
    ollamaPull: pullState,
    system: getManagedProcessStatus(),
  });
});

app.post('/api/system/start/:target', async (request, response) => {
  const target = request.params.target;
  if (target !== 'ollama' && target !== 'app' && target !== 'mobile') {
    appendBackendDebugLog('warn', 'system.start.invalidTarget', { target });
    response.status(400).json({
      error: 'Ungueltiges target. Erlaubt: ollama, app, mobile.',
    });
    return;
  }

  // For Ollama: if it already answers (started externally or by us earlier), do
  // NOT spawn a second `ollama serve` — that only fails to bind the busy port.
  // Report it as "läuft extern/managed" instead of a hard error.
  if (target === 'ollama') {
    const runtime = await getOllamaRuntime();
    if (runtime.reachable) {
      appendBackendDebugLog('info', 'system.start.ollama.alreadyReachable', {
        source: runtime.source,
      });
      response.json({
        ok: true,
        action: 'start:ollama',
        alreadyRunning: true,
        ollamaRuntime: runtime,
        message:
          runtime.source === 'external'
            ? `Ollama läuft bereits extern unter ${runtime.host} — kein eigener Start nötig.`
            : `Ollama läuft bereits (managed) unter ${runtime.host}.`,
        system: getManagedProcessStatus(),
      });
      return;
    }
  }

  const state = startManagedProcess(target);
  appendBackendDebugLog('info', 'system.start.executed', { target });
  response.json({
    ok: true,
    action: `start:${target}`,
    system: getManagedProcessStatus(),
    target: state,
  });
});

app.post('/api/system/stop/:target', async (request, response) => {
  const target = request.params.target;
  if (target !== 'ollama' && target !== 'app' && target !== 'mobile') {
    appendBackendDebugLog('warn', 'system.stop.invalidTarget', { target });
    response.status(400).json({
      error: 'Ungueltiges target. Erlaubt: ollama, app, mobile.',
    });
    return;
  }

  const state = await stopManagedProcess(target);
  appendBackendDebugLog('info', 'system.stop.executed', { target });
  response.json({
    ok: true,
    action: `stop:${target}`,
    system: getManagedProcessStatus(),
    target: state,
  });
});

// /api/system/backend/restart — startet das Backend SELBST sauber neu (Admin-v2
// Kopfzeilen-Button). Ein entkoppelter Relauncher wartet auf das Ende dieser PID +
// die Portfreigabe und ruft dann den robusten Launcher scripts/start-backend.ps1
// erneut auf; danach fährt diese Instanz sauber herunter (kein harter Kill).
app.post('/api/system/backend/restart', (_request, response) => {
  appendBackendDebugLog('warn', 'system.backend.restart.requested', { pid: process.pid, port });
  let spec;
  try {
    spec = buildBackendRestartSpec({
      platform: process.platform,
      repoRoot: process.cwd(),
      port,
      currentPid: process.pid,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Neustart nicht unterstützt.';
    appendBackendDebugLog('error', 'system.backend.restart.unsupported', { message });
    response.status(501).json({ ok: false, error: message });
    return;
  }

  const result = requestBackendRestart({
    spec,
    spawnRelauncher: (s) => {
      const child = spawn(s.command, s.args, s.options);
      child.unref();
    },
    shutdown: {
      closeServer: () => httpServer.close(),
      exit: (code) => process.exit(code),
      schedule: (fn, ms) => setTimeout(fn, ms).unref(),
      log: lifecycleLog,
    },
    log: lifecycleLog,
  });

  response.status(result.ok ? 202 : 500).json({ ...result, system: getManagedProcessStatus() });
});

// /api/system/backend/shutdown — beendet das Backend SELBST sauber (Admin-v2
// „Backend beenden"-Button): HTTP-Server schließen, dann process.exit(0). Bewusst
// KEIN harter Kill — der Lifecycle-Logger erklärt den Exit.
app.post('/api/system/backend/shutdown', (_request, response) => {
  appendBackendDebugLog('warn', 'system.backend.shutdown.requested', { pid: process.pid });
  const result = requestBackendShutdown({
    closeServer: () => httpServer.close(),
    exit: (code) => process.exit(code),
    schedule: (fn, ms) => setTimeout(fn, ms).unref(),
    log: lifecycleLog,
  });
  response.status(202).json({ ...result, system: getManagedProcessStatus() });
});

app.post('/api/system/mobile/input', (request, response) => {
  const validation = mobileInputSchema.safeParse(request.body ?? {});
  if (!validation.success) {
    response.status(400).json({
      error: 'Ungueltige mobile Eingabe.',
      details: validation.error.flatten(),
    });
    return;
  }

  try {
    const state = sendManagedProcessInput('mobile', validation.data.input);
    response.json({
      ok: true,
      action: `mobile:input:${validation.data.input}`,
      system: getManagedProcessStatus(),
      target: state,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Mobile Eingabe konnte nicht gesendet werden.';
    response.status(409).json({
      error: message,
      system: getManagedProcessStatus(),
    });
  }
});

app.post('/api/system/mobile/refresh', (request, response) => {
  try {
    const state = sendManagedProcessInput('mobile', 'r');
    appendBackendDebugLog('info', 'system.mobile.refresh.executed', {
      input: 'r',
    });
    response.json({
      ok: true,
      action: 'mobile:refresh:r',
      system: getManagedProcessStatus(),
      target: state,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Mobile Refresh fehlgeschlagen.';
    appendBackendDebugLog('warn', 'system.mobile.refresh.failed', {
      error: message,
    });
    response.status(409).json({
      error: message,
      system: getManagedProcessStatus(),
    });
  }
});

app.post('/api/system/mobile/open-console', (_request, response) => {
  const backendUrl = `http://localhost:${port}`;
  const result = openMobileCommandConsole(backendUrl);
  if (!result.ok) {
    response.status(409).json({
      error: result.message,
      system: getManagedProcessStatus(),
    });
    return;
  }

  response.json({
    ok: true,
    action: 'mobile:open-console',
    message: result.message,
    system: getManagedProcessStatus(),
  });
});

app.post('/api/debug/client-error', (request, response) => {
  const validation = clientErrorReportSchema.safeParse(request.body ?? {});
  if (!validation.success) {
    appendBackendDebugLog('warn', 'debug.clientError.invalidPayload', {
      issues: validation.error.issues.map((issue) => issue.message),
    });
    response.status(400).json({
      error: 'Ungueltige Client-Error-Payload.',
      details: validation.error.flatten(),
    });
    return;
  }

  appendBackendDebugLog('error', 'debug.clientError', validation.data);
  response.json({ ok: true });
});

app.get('/api/debug/state', (_request, response) => {
  appendBackendDebugLog('info', 'debug.state.read');
  response.json({
    backendTime: new Date().toISOString(),
    offersCount: snapshot.offers.length,
    nextWeekOffersCount: snapshot.nextWeekOffers.length,
    filteredOffersCount: snapshot.filteredOffers.length,
    nextWeekOffers: snapshot.nextWeekOffers,
    offerScopes: snapshot.offerScopes,
    scopeSummary: getOfferScopeSummary(),
    updatedAt: snapshot.updatedAt,
    warnings: snapshot.warnings,
    ingest: ingestState,
    aiRescan: aiRescanState,
    oneClickAi: oneClickAiState,
    system: getManagedProcessStatus(),
    ollamaPull: getOllamaPullStatus(),
    config: {
      port,
      frontendUrl,
      ollamaHost: resolveOllamaHost(),
      ollamaModel: resolveOllamaModel(),
    },
  });
});

app.get('/api/debug/logs', (request, response) => {
  const limitRaw = Number(request.query.limit ?? 200);
  const limit = Number.isFinite(limitRaw) ? limitRaw : 200;
  appendBackendDebugLog('info', 'debug.logs.read', { limit });
  response.json({
    logs: readBackendDebugLogs(limit),
  });
});

app.post('/api/debug/clear', (_request, response) => {
  clearBackendDebugLogs();
  appendBackendDebugLog('info', 'debug.logs.cleared');
  response.json({
    ok: true,
    message: 'Debug logs cleared.',
    logs: readBackendDebugLogs(10),
  });
});

app.use(
  (
    error: unknown,
    request: Request,
    response: Response,
    next: NextFunction,
  ) => {
    void next;
    const isError = error instanceof Error;
    const message = isError ? error.message : stringifyUnknownError(error);
    const stack = isError ? error.stack : undefined;

    appendBackendDebugLog('error', 'http.unhandledError', {
      method: request.method,
      path: request.path,
      message,
      stack,
    });

    if (response.headersSent) {
      return;
    }

    // Body-parser (raw-body) wirft PayloadTooLargeError mit type ===
    // 'entity.too.large' wenn der Request-Body über express.json's `limit`
    // hinausschießt. Statt "Interner Serverfehler" liefern wir 413 mit
    // einer konkreten Botschaft, sonst sieht der User im REWE-Import-Flow
    // nur ein verwirrendes 500-Popup ohne Größenhinweis.
    const errorType = isError ? (error as Error & { type?: string }).type : undefined;
    if (
      errorType === 'entity.too.large' ||
      (isError && error.name === 'PayloadTooLargeError')
    ) {
      response.status(413).json({
        error:
          'Datei zu groß. Maximum sind ~225 MB PDF / ~225 MB Screenshot. Bitte das PDF im Browser exportieren mit niedrigerer Qualität oder weniger Seiten und erneut hochladen.',
        message,
      });
      return;
    }

    response.status(500).json({
      error: 'Interner Serverfehler.',
      message,
    });
  },
);

const httpServer = app.listen(port, bindHost, () => {
  appendBackendDebugLog('info', 'backend.started', {
    port,
    bindHost,
    bindIsPublic,
    frontendUrl,
  });
  console.log(
    `[AIChef Backend] API laeuft auf http://${bindHost}:${port} ` +
      `(bereit nach ${(process.uptime() * 1000).toFixed(0)} ms ab Prozessstart).`,
  );
  if (bindIsPublic) {
    // Laut, weil dieser Prozess ohne Auth laeuft und Service-Role-Rechte haelt.
    console.warn(
      `[AIChef Backend] WARNUNG: Bindung an ${bindHost} — das Backend ist im ` +
        'gesamten Netzwerk erreichbar. /admin-v2 und die System-Endpoints haben ' +
        'KEINE Authentifizierung. Nur in vertrauenswuerdigen Netzen nutzen; ' +
        'zum Abschalten BIND_HOST aus der .env entfernen.',
    );
  } else {
    console.log(
      '[AIChef Backend] Nur lokal erreichbar. Fuer Handy-Tests im WLAN: ' +
        'BIND_HOST=0.0.0.0 in der .env setzen.',
    );
  }
  // Start the in-process weekly auto-scan scheduler (no-op unless enabled).
  startWeeklyScanScheduler();
});

httpServer.on('error', (error: NodeJS.ErrnoException) => {
  appendBackendDebugLog('error', 'backend.listen.failed', {
    port,
    code: error.code ?? null,
    message: error.message,
  });

  if (error.code === 'EADDRINUSE') {
    console.error(
      `[AIChef Backend] Port ${port} ist bereits belegt. Stoppe den alten Prozess oder nutze z.B. PORT=${
        port + 1
      } npm run dev:server`,
    );
  }
});
