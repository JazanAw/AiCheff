// KI-Preflight for the offer scan.
//
// Before a KI-Rescan / One-Click-KI run is allowed to start, we verify that
// Ollama can actually do the job:
//   1. reachable      — GET /api/tags responds (managed OR externally started)
//   2. model present  — the configured scan model is installed
//   3. residency      — GET /api/ps: is the model already loaded & GPU-resident?
//   4. smoke test     — a tiny chat must return USABLE FINAL TEXT, not just a
//                       reasoning trace. Thinking models (Qwen3) can spend the
//                       whole token budget on `message.thinking` and leave
//                       `message.content` empty even though HTTP 200 came back.
//                       The smoke therefore (a) sends `think:false` so the model
//                       emits a final answer directly, (b) gives a small but
//                       sufficient `num_predict` budget (not a single token), and
//                       (c) does EXACTLY ONE retry when the first call returns
//                       only thinking / nothing. A timeout while the model is
//                       provably GPU-resident still soft-passes (a warm 14B can
//                       be briefly slow under load), but a persistent empty final
//                       answer on HTTP 200 is a real failure — Phase 2 needs
//                       final text, so we never wave that through on residency.
//
// If a genuine problem is found (unreachable / model missing / model NOT loaded
// AND smoke fails) the caller refuses to start and the snapshot is left
// untouched. This guard stops the original failure — a scan that ran for hours
// while every `POST /api/chat` returned 500 — without falsely blocking a healthy
// already-loaded model behind a slow smoke test, and without falsely blocking a
// healthy thinking model whose first token went to reasoning.
//
// Pure + injectable: `fetchImpl` can be supplied so the whole flow is
// unit-testable without a real Ollama.

export type OllamaPreflightStage = 'reachable' | 'model' | 'smoke';

/**
 * Honest, machine-readable classification of WHY the preflight reached its
 * decision. Distinct from the coarse `reason` (which only drives HTTP status
 * mapping) so logs / status can show the precise cause without changing the
 * existing 503 contract.
 */
export type OllamaPreflightDiagnostic =
  // success paths
  | 'ok' // first smoke returned usable final content
  | 'skipped_loaded' // smoke skipped: model already loaded & GPU-resident
  | 'recovered_after_retry' // first call empty/thinking-only, retry gave content
  | 'soft_pass_resident' // smoke timed out but model is provably GPU-resident
  // failure paths
  | 'empty_final_after_thinking' // HTTP 200 but only thinking, no final content
  | 'empty_response' // HTTP 200 but neither content nor thinking
  | 'invalid_response' // HTTP 200 but the payload had no usable message shape
  | 'timeout' // smoke aborted on the timeout / connection dropped
  | 'http_error' // smoke returned a non-2xx status
  | 'model_missing' // configured model not installed
  | 'unreachable'; // /api/tags did not answer

/** Compact, log-safe diagnostics about the smoke attempt(s). Never carries the
 *  model's actual text — only lengths and protocol fields. */
export interface OllamaSmokeDiag {
  attempts: number;
  retried: boolean;
  /** `think:false` was sent on every smoke call. */
  thinkingDisabled: boolean;
  residentBeforeSmoke: boolean;
  residentAfterSmoke: boolean;
  /** Length of the final `message.content` (trimmed) on the authoritative call. */
  contentLength: number;
  /** Length of `message.thinking` (trimmed) on the authoritative call. */
  thinkingLength: number;
  done: boolean | null;
  doneReason: string | null;
  httpStatus: number | null;
}

export interface OllamaPreflightConfig {
  host: string;
  model: string;
  /** Overall budget for the smoke chat (ms). Reachability uses a short slice. */
  smokeTimeoutMs?: number;
  reachableTimeoutMs?: number;
  /** Timeout for the /api/ps residency probe (ms). */
  psTimeoutMs?: number;
  /** When the model is already loaded & GPU-resident, cap the smoke timeout to
   *  this (a warm model answers fast; no need to wait the full budget). */
  loadedSmokeTimeoutMs?: number;
  /** Skip the chat smoke entirely when /api/ps proves the model is loaded &
   *  GPU-resident (fastest path; used by the incremental scan). */
  skipSmokeIfLoaded?: boolean;
  fetchImpl?: typeof fetch;
}

export interface OllamaPreflightOk {
  ok: true;
  model: string;
  installedModels: string[];
  smokeMs: number;
  /** True when the chat smoke was skipped because the model is already loaded. */
  smokeSkipped?: boolean;
  /** Non-null when we soft-passed: e.g. the smoke timed out, but /api/ps shows
   *  the model loaded & GPU-resident, so the run proceeds with a heads-up. */
  warning?: string | null;
  /** /api/ps residency snapshot used for the decision. When the model was not
   *  resident before the smoke, this is the POST-smoke snapshot (the smoke may
   *  have just loaded it), so callers see the up-to-date residency. */
  ps?: OllamaPsStatus | null;
  /** Precise cause classification for honest logs / status. */
  diagnostic?: OllamaPreflightDiagnostic;
  /** Smoke diagnostics (log-safe: lengths + protocol fields only). */
  smoke?: OllamaSmokeDiag;
}

export interface OllamaPreflightFailure {
  ok: false;
  stage: OllamaPreflightStage;
  /** Machine-readable reason for status mapping / tests. */
  reason: 'unreachable' | 'model_missing' | 'smoke_failed';
  message: string;
  installedModels?: string[];
  /** Precise cause classification for honest logs / status. */
  diagnostic?: OllamaPreflightDiagnostic;
  /** Smoke diagnostics when the failure happened at the smoke stage. */
  smoke?: OllamaSmokeDiag;
}

export type OllamaPreflightResult = OllamaPreflightOk | OllamaPreflightFailure;

interface OllamaTagsResponse {
  models?: Array<{ name?: unknown; model?: unknown }>;
}

function cleanHost(host: string): string {
  return host.trim().replace(/\/+$/, '');
}

/** Names Ollama reports look like "qwen3:14b" or "qwen3:14b-q4_K_M". A request
 *  for "qwen3:14b" should match an installed "qwen3:14b"; a request without a
 *  tag ("qwen3") matches any tag of that base. Case-insensitive. */
export function isModelInstalled(model: string, installed: string[]): boolean {
  const want = model.trim().toLowerCase();
  if (!want) return false;
  const wantBase = want.split(':')[0];
  for (const raw of installed) {
    const have = String(raw).trim().toLowerCase();
    if (!have) continue;
    if (have === want) return true;
    // "qwen3" requested → match "qwen3:latest", "qwen3:14b", …
    if (!want.includes(':') && have.split(':')[0] === wantBase) return true;
    // "qwen3:14b" requested → tolerate an extra quant suffix "qwen3:14b-q4_K_M".
    if (have.startsWith(`${want}-`)) return true;
  }
  return false;
}

function extractModelNames(payload: unknown): string[] {
  const models = (payload as OllamaTagsResponse | null | undefined)?.models;
  if (!Array.isArray(models)) return [];
  const names: string[] = [];
  for (const entry of models) {
    const name = entry?.name ?? entry?.model;
    if (typeof name === 'string' && name.trim().length > 0) {
      names.push(name.trim());
    }
  }
  return names;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const BYTES_PER_GIB = 1024 * 1024 * 1024;

/**
 * Whether /api/ps proves the model is loaded and (plausibly) sitting on the GPU.
 * `size_vram` must be > 0; if the total `size` is known, at least half must be in
 * VRAM. Used to soft-pass a slow smoke test instead of hard-blocking a warm,
 * GPU-resident model.
 */
export function isGpuResidentPlausible(ps: OllamaPsStatus | null | undefined): boolean {
  if (!ps || !ps.loaded) return false;
  if (!(ps.sizeVramBytes > 0)) return false;
  if (!(ps.sizeBytes > 0)) return true; // loaded with VRAM, unknown total → trust
  return ps.sizeVramBytes >= ps.sizeBytes * 0.5;
}

export type OllamaRuntimeSource = 'managed' | 'external' | 'unavailable';

/**
 * Classify the Ollama runtime from two independent signals: whether OUR managed
 * `ollama serve` process is running, and whether the host actually answers. An
 * externally started Ollama (reachable but not managed by us) is fully valid.
 */
export function classifyOllamaRuntime(managedRunning: boolean, reachable: boolean): OllamaRuntimeSource {
  if (!reachable) return 'unavailable';
  return managedRunning ? 'managed' : 'external';
}

// --- Shared Ollama /api/chat response normalization ----------------------------
//
// One parser for the smoke test so "did the model actually produce usable final
// text?" is decided in exactly one place. The production Phase-2 classifier
// (internationalFood.ts) already sends `think:false` and reads
// `message.content ?? response`; this mirrors that shape so the smoke and the
// real call agree on what "a usable answer" means.

export type OllamaResponseKind =
  | 'final_content' // usable, non-empty `message.content` (or top-level `response`)
  | 'thinking_only' // only `message.thinking` present, final content empty
  | 'empty' // HTTP 200 but neither final content nor thinking
  | 'invalid'; // payload not an object / no message/response shape at all

export interface OllamaChatNormalized {
  kind: OllamaResponseKind;
  /** Trimmed final answer text (`message.content` or top-level `response`). */
  content: string;
  /** Trimmed reasoning trace (`message.thinking`), when present. */
  thinking: string;
  done: boolean | null;
  doneReason: string | null;
  /** Ollama's `error` field when the body carried one despite HTTP 200. */
  errorField: string | null;
}

/**
 * Classify an Ollama `/api/chat` (stream:false) response body. Pure; takes the
 * already-parsed JSON. Treats a top-level `response` string the same as
 * `message.content` (Ollama's generate-style envelope) so both transports agree.
 */
export function normalizeOllamaChatResponse(payload: unknown): OllamaChatNormalized {
  if (!payload || typeof payload !== 'object') {
    return { kind: 'invalid', content: '', thinking: '', done: null, doneReason: null, errorField: null };
  }
  const p = payload as Record<string, unknown>;
  const message =
    p.message && typeof p.message === 'object' ? (p.message as Record<string, unknown>) : null;
  const contentRaw = message?.content;
  const thinkingRaw = message?.thinking;
  const responseRaw = p.response;

  const content =
    typeof contentRaw === 'string' && contentRaw.trim().length > 0
      ? contentRaw.trim()
      : typeof responseRaw === 'string'
        ? responseRaw.trim()
        : '';
  const thinking = typeof thinkingRaw === 'string' ? thinkingRaw.trim() : '';
  const done = typeof p.done === 'boolean' ? p.done : null;
  const doneReason = typeof p.done_reason === 'string' ? p.done_reason : null;
  const errorField =
    typeof p.error === 'string' && p.error.trim().length > 0 ? p.error.trim() : null;

  let kind: OllamaResponseKind;
  if (!message && typeof responseRaw !== 'string') {
    kind = 'invalid';
  } else if (content.length > 0) {
    kind = 'final_content';
  } else if (thinking.length > 0) {
    kind = 'thinking_only';
  } else {
    kind = 'empty';
  }
  return { kind, content, thinking, done, doneReason, errorField };
}

/** A small but sufficient generation budget for the smoke. NOT one token: a
 *  thinking model can burn a single token entirely on reasoning. */
const SMOKE_NUM_PREDICT_FIRST = 16;
const SMOKE_NUM_PREDICT_RETRY = 32;

/**
 * Build the smoke chat request. `think:false` (top-level, per the Ollama chat
 * API used by the prod classifier) forces a final answer instead of a reasoning
 * trace; temperature 0 + a tiny deterministic prompt keep it cheap.
 */
function buildSmokeRequestBody(model: string, numPredict: number): string {
  return JSON.stringify({
    model,
    stream: false,
    think: false,
    keep_alive: '10m',
    options: { temperature: 0, num_predict: numPredict },
    messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
  });
}

type SmokeErrorKind = 'timeout' | 'http_error' | 'network';

interface SmokeAttempt {
  /** HTTP request succeeded with a 2xx and a parseable body. */
  ok: boolean;
  httpStatus: number | null;
  normalized: OllamaChatNormalized | null;
  errorKind: SmokeErrorKind | null;
  /** Short, truncated HTTP error detail (never the full model text). */
  detail: string | null;
}

/** Run a single smoke chat attempt. Network/timeout/HTTP failures are captured,
 *  never thrown, so the caller can decide retry / soft-pass deterministically. */
async function runSmokeAttempt(
  fetchImpl: typeof fetch,
  host: string,
  model: string,
  timeoutMs: number,
  numPredict: number,
): Promise<SmokeAttempt> {
  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      `${host}/api/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: buildSmokeRequestBody(model, numPredict),
      },
      timeoutMs,
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return {
        ok: false,
        httpStatus: response.status,
        normalized: null,
        errorKind: 'http_error',
        detail: detail ? detail.slice(0, 160) : null,
      };
    }
    const normalized = normalizeOllamaChatResponse(await response.json().catch(() => null));
    return { ok: true, httpStatus: response.status, normalized, errorKind: null, detail: null };
  } catch (error) {
    // AbortController.abort() surfaces as an AbortError; anything else mid-flight
    // is a connection drop. Both are transient and eligible for residency
    // soft-pass, but hard HTTP errors above are not.
    const aborted =
      typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
    return {
      ok: false,
      httpStatus: null,
      normalized: null,
      errorKind: aborted ? 'timeout' : 'network',
      detail: null,
    };
  }
}

/**
 * Run the preflight. Resolves to a discriminated result; never throws for an
 * expected failure (unreachable/missing/smoke) — those are returned as
 * `{ ok: false, ... }` so the caller maps them to HTTP 503. An `ok` result may
 * carry a `warning` (soft-pass) and the `/api/ps` snapshot.
 */
export async function runOllamaPreflight(
  config: OllamaPreflightConfig,
): Promise<OllamaPreflightResult> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const host = cleanHost(config.host);
  const model = config.model.trim();
  const reachableTimeoutMs = config.reachableTimeoutMs ?? 2500;
  const smokeTimeoutMs = config.smokeTimeoutMs ?? 20000;
  const psTimeoutMs = config.psTimeoutMs ?? 2500;
  const loadedSmokeTimeoutMs = config.loadedSmokeTimeoutMs ?? 6000;

  // 1) Reachability + installed models.
  let installedModels: string[];
  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      `${host}/api/tags`,
      { method: 'GET', headers: { Accept: 'application/json' } },
      reachableTimeoutMs,
    );
    if (!response.ok) {
      return {
        ok: false,
        stage: 'reachable',
        reason: 'unreachable',
        message: `Ollama unter ${host} antwortete mit HTTP ${response.status}. Bitte Ollama starten.`,
      };
    }
    installedModels = extractModelNames(await response.json());
  } catch {
    return {
      ok: false,
      stage: 'reachable',
      reason: 'unreachable',
      message: `Ollama ist unter ${host} nicht erreichbar. Bitte Ollama starten und erneut versuchen.`,
    };
  }

  // 2) Model installed?
  if (!isModelInstalled(model, installedModels)) {
    return {
      ok: false,
      stage: 'model',
      reason: 'model_missing',
      message:
        `Modell "${model}" ist nicht installiert. ` +
        `Mit "ollama pull ${model}" laden oder ein installiertes Modell wählen. ` +
        `Installiert: ${installedModels.join(', ') || '—'}.`,
      installedModels,
    };
  }

  // 3) Residency probe — is the model already loaded & GPU-resident?
  const psBefore = await getOllamaPsStatus({ host, model, fetchImpl, timeoutMs: psTimeoutMs }).catch(
    () => null,
  );
  const residentBefore = isGpuResidentPlausible(psBefore);

  // Fast path: a loaded, GPU-resident model needs no chat smoke at all.
  if (config.skipSmokeIfLoaded && residentBefore) {
    return {
      ok: true,
      model,
      installedModels,
      smokeMs: 0,
      smokeSkipped: true,
      warning: null,
      ps: psBefore,
      diagnostic: 'skipped_loaded',
    };
  }

  // 4) Smoke chat. When the model is already loaded we cap the timeout low — a
  //    warm model answers immediately; we don't wait the full budget. The smoke
  //    sends `think:false` so a thinking model emits FINAL text, not just a
  //    reasoning trace, and uses a small-but-sufficient token budget.
  const effectiveSmokeTimeoutMs = residentBefore
    ? Math.min(smokeTimeoutMs, loadedSmokeTimeoutMs)
    : smokeTimeoutMs;
  const startedAt = Date.now();

  const first = await runSmokeAttempt(
    fetchImpl,
    host,
    model,
    effectiveSmokeTimeoutMs,
    SMOKE_NUM_PREDICT_FIRST,
  );

  // Retry EXACTLY ONCE when the first call came back HTTP 200 but with no usable
  // final text — either only a reasoning trace (thinking-only) or nothing at all
  // (the token budget was consumed before any final tokens). The retry must
  // PROVE the model can produce final content; a hard HTTP error gets no retry.
  const firstKind = first.normalized?.kind ?? null;
  const shouldRetry =
    first.ok && (firstKind === 'thinking_only' || firstKind === 'empty');
  let authoritative = first;
  let retried = false;
  if (shouldRetry) {
    retried = true;
    authoritative = await runSmokeAttempt(
      fetchImpl,
      host,
      model,
      effectiveSmokeTimeoutMs,
      SMOKE_NUM_PREDICT_RETRY,
    );
  }

  const smokeMs = Date.now() - startedAt;

  // 5) Re-probe residency AFTER the smoke when the model was not loaded before:
  //    the smoke itself may have just loaded it. The final decision and the
  //    returned `ps` then reflect the up-to-date state, not the cold snapshot.
  let psFinal = psBefore;
  let residentAfter = residentBefore;
  if (!residentBefore) {
    const psAfter = await getOllamaPsStatus({
      host,
      model,
      fetchImpl,
      timeoutMs: psTimeoutMs,
    }).catch(() => null);
    if (psAfter) {
      psFinal = psAfter;
      residentAfter = isGpuResidentPlausible(psAfter);
    }
  }
  const resident = residentBefore || residentAfter;
  const vramLabel =
    psFinal && psFinal.sizeVramBytes > 0
      ? `${(psFinal.sizeVramBytes / BYTES_PER_GIB).toFixed(1)} GiB`
      : null;

  const norm = authoritative.normalized;
  const smokeDiag: OllamaSmokeDiag = {
    attempts: retried ? 2 : 1,
    retried,
    thinkingDisabled: true,
    residentBeforeSmoke: residentBefore,
    residentAfterSmoke: residentAfter,
    contentLength: norm?.content.length ?? 0,
    thinkingLength: norm?.thinking.length ?? 0,
    done: norm?.done ?? null,
    doneReason: norm?.doneReason ?? null,
    httpStatus: authoritative.httpStatus,
  };

  // --- Success: the model produced usable FINAL content. ---
  if (authoritative.ok && norm && norm.kind === 'final_content') {
    return {
      ok: true,
      model,
      installedModels,
      smokeMs,
      warning: retried
        ? `Ollama "${model}" lieferte erst nach einem Retry (think:false) finalen Inhalt — ` +
          `erster Smoke-Call ohne nutzbare Antwort. Lauf faehrt fort.`
        : null,
      ps: psFinal,
      diagnostic: retried ? 'recovered_after_retry' : 'ok',
      smoke: smokeDiag,
    };
  }

  // --- Transient transport problem (timeout / connection drop). ---
  // Soft-pass ONLY when /api/ps proves the model is GPU-resident: a warm 14B can
  // be briefly slow under load and must not hard-block. A hard HTTP error is NOT
  // transient and is never soft-passed.
  const transportError =
    authoritative.errorKind === 'timeout' || authoritative.errorKind === 'network';
  if (transportError && resident) {
    const why =
      authoritative.errorKind === 'timeout'
        ? `ueberschritt das Zeitlimit (${effectiveSmokeTimeoutMs} ms)`
        : 'brach die Verbindung ab';
    return {
      ok: true,
      model,
      installedModels,
      smokeMs,
      warning:
        `Ollama erreichbar und "${model}" ist geladen` +
        `${vramLabel ? ` (size_vram ${vramLabel})` : ''}, aber der Smoke-Test ${why}. ` +
        `Lauf faehrt fort — Modell evtl. unter Last langsam.`,
      ps: psFinal,
      diagnostic: 'soft_pass_resident',
      smoke: smokeDiag,
    };
  }

  // --- Genuine failures. Classify honestly; Phase 2 needs real final text, so a
  //     persistent empty/thinking-only HTTP 200 is a hard failure even when the
  //     model is GPU-resident. ---
  let diagnostic: OllamaPreflightDiagnostic;
  let message: string;
  if (authoritative.errorKind === 'http_error') {
    diagnostic = 'http_error';
    message =
      `Ollama-Smoke-Test mit "${model}" antwortete mit HTTP ${authoritative.httpStatus ?? '???'}` +
      `${authoritative.detail ? `: ${authoritative.detail}` : ''}. Modell evtl. nicht vollstaendig geladen.`;
  } else if (authoritative.errorKind === 'timeout' || authoritative.errorKind === 'network') {
    diagnostic = 'timeout';
    message =
      `Ollama-Smoke-Test mit "${model}" ${
        authoritative.errorKind === 'timeout'
          ? `ueberschritt das Zeitlimit (${effectiveSmokeTimeoutMs} ms)`
          : 'brach die Verbindung ab'
      } und das Modell ist nicht nachweislich GPU-resident.`;
  } else if (norm && norm.kind === 'invalid') {
    diagnostic = 'invalid_response';
    message = `Ollama-Smoke-Test mit "${model}" lieferte ein ungueltiges Antwort-Payload.`;
  } else if (norm && norm.kind === 'thinking_only') {
    diagnostic = 'empty_final_after_thinking';
    message =
      `Ollama-Smoke-Test mit "${model}" lieferte nur eine Reasoning-Spur (thinking) und ` +
      `auch nach einem Retry mit think:false keinen finalen Inhalt. Phase 2 benoetigt finalen Text.`;
  } else if (firstKind === 'thinking_only') {
    // First call was thinking-only; the retry came back fully empty.
    diagnostic = 'empty_final_after_thinking';
    message =
      `Ollama-Smoke-Test mit "${model}" lieferte zunaechst nur thinking und beim Retry ` +
      `(think:false) eine leere Antwort. Phase 2 benoetigt finalen Text.`;
  } else {
    diagnostic = 'empty_response';
    message =
      `Ollama-Smoke-Test lieferte eine leere Antwort von "${model}"` +
      `${retried ? ' (auch nach einem Retry mit think:false)' : ''}.`;
  }

  return {
    ok: false,
    stage: 'smoke',
    reason: 'smoke_failed',
    message,
    installedModels,
    diagnostic,
    smoke: smokeDiag,
  };
}

// --- Loaded-model GPU residency ------------------------------------------------
//
// After the smoke test loads the model, the weekly-scan GPU preflight needs to
// know whether the model actually sits on the GPU. Two complementary sources:
//
//   * Ollama's load log line "offloaded 41/41 layers to GPU" — exact layer
//     counts, but only captured when WE started `ollama serve` (piped stderr).
//   * The /api/ps endpoint — `size` / `size_vram` bytes per running model; works
//     regardless of who started Ollama, but has no layer counts.
//
// Both are best-effort: a missing signal just means "unknown", never an error.

/**
 * Parse the most recent Ollama "offloaded X/Y layers to GPU" line from captured
 * log lines. Ollama logs one such line per model load; we take the LAST match so
 * the result reflects the current model. Returns null when no line is present.
 */
export function parseOllamaOffloadLayers(
  logLines: readonly string[],
): { gpuLayers: number; totalLayers: number } | null {
  let result: { gpuLayers: number; totalLayers: number } | null = null;
  const pattern = /offloaded\s+(\d+)\s*\/\s*(\d+)\s+layers?\s+to\s+gpu/i;
  for (const line of logLines ?? []) {
    const match = pattern.exec(String(line ?? ''));
    if (!match) continue;
    const gpuLayers = Number(match[1]);
    const totalLayers = Number(match[2]);
    if (Number.isFinite(gpuLayers) && Number.isFinite(totalLayers) && totalLayers > 0) {
      result = { gpuLayers, totalLayers };
    }
  }
  return result;
}

export interface OllamaPsStatus {
  /** The configured model is currently listed as running by /api/ps. */
  loaded: boolean;
  /** Total model bytes (resident estimate). */
  sizeBytes: number;
  /** Bytes resident in VRAM (size_vram). */
  sizeVramBytes: number;
}

interface OllamaPsResponse {
  models?: Array<{
    name?: unknown;
    model?: unknown;
    size?: unknown;
    size_vram?: unknown;
  }>;
}

function toFiniteNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Query Ollama /api/ps and report VRAM residency of the configured model.
 * Returns `{ loaded: false, ... }` when the model is not running, and null on
 * any error (unreachable / bad payload) — callers treat null as "unknown" and
 * fall back to other signals, never as a hard failure.
 */
export async function getOllamaPsStatus(config: {
  host: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<OllamaPsStatus | null> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const host = cleanHost(config.host);
  const model = config.model.trim();
  const timeoutMs = config.timeoutMs ?? 2500;

  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      `${host}/api/ps`,
      { method: 'GET', headers: { Accept: 'application/json' } },
      timeoutMs,
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as OllamaPsResponse | null;
    const models = Array.isArray(payload?.models) ? payload.models : [];
    for (const entry of models) {
      const name = entry?.name ?? entry?.model;
      if (typeof name !== 'string' || name.trim().length === 0) continue;
      if (!isModelInstalled(model, [name])) continue;
      return {
        loaded: true,
        sizeBytes: toFiniteNumber(entry?.size),
        sizeVramBytes: toFiniteNumber(entry?.size_vram),
      };
    }
    return { loaded: false, sizeBytes: 0, sizeVramBytes: 0 };
  } catch {
    return null;
  }
}
