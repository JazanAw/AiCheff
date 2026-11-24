// Angebots-Scan 2.0 — persistent pause/resume checkpoint.
//
// A full Scan 2.0 with Qwen3:14b runs for a long time, so the operator must be
// able to PAUSE it, restart the backend, and RESUME from exactly where it
// stopped — without re-scraping, without re-sending already-analysed Phase-2
// candidates to the model, and without losing the manually imported REWE/nahkauf
// offers preserved in the snapshot.
//
// This module owns the on-disk checkpoint and the small pure helpers the resume
// logic needs. It is deliberately IO-light and dependency-free (only the Offer
// type) so it is fully unit-testable. The heavy run logic lives in server.ts and
// only calls these primitives.
//
// Design notes:
//   • Writes are ATOMIC: serialise → temp file in the same dir → fsync-free
//     rename over the target. A crash mid-write can never truncate the real
//     checkpoint, so the previously committed checkpoint always stays readable.
//   • Reads are HONEST about corruption: a malformed/old-version file throws
//     CheckpointCorruptError instead of silently returning a half object, so the
//     resume endpoint can refuse cleanly and never apply a broken snapshot.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Offer } from '../../src/types/models';
import type { SubSourceDiagnostic } from '../../src/services/offersIngest/subSourceDiagnostics';
import { modeIncludesPhase1, type ScanV2Mode, type ScanV2Phase } from './offersScanV2';
import {
  allStoresScope,
  deriveScopeFromOffers,
  normalizeScope,
  type ScanV2Scope,
} from './scanV2Scope';

/** Bump when the on-disk shape changes incompatibly — an old file then refuses
 *  to resume (CheckpointCorruptError) instead of feeding stale data into a run. */
export const SCAN_V2_CHECKPOINT_VERSION = 1;

/** Thrown when a checkpoint file exists but cannot be trusted (bad JSON, wrong
 *  version, missing required fields). Distinct from "absent" (→ null) so the
 *  resume endpoint can return a clear 4xx without ever touching the snapshot. */
export class CheckpointCorruptError extends Error {
  public constructor(message = 'Scan-2.0-Checkpoint ist beschädigt oder veraltet.') {
    super(message);
    this.name = 'CheckpointCorruptError';
  }
}

/** Phase-1 progress saved so resume never re-scrapes and continues categorising
 *  from `processedIndex` (not from 0). */
export interface ScanV2CheckpointPhase1 {
  /** Raw scraped offers (post store-exclusion) — the resume input. */
  rawOffers: Offer[];
  /** How many of `rawOffers` have already been categorised + committed below. */
  processedIndex: number;
  /** Categorised food accumulated from completed batches (pre image-check). */
  categorizedFood: Offer[];
  /** Categorised sure non-food accumulated from completed batches. */
  categorizedNonFood: Offer[];
  /** REWE/nahkauf (excluded-store) offers retained from the live snapshot at
   *  scrape time, so the Phase-1 finalize merge can preserve the manual imports. */
  preservedExcluded: { current: Offer[]; next: Offer[]; filtered: Offer[] };
  /** Offer scope map captured from the scrape (national/local per id). */
  offerScopes: Record<string, unknown>;
  scrapeWarnings: string[];
  /** Strukturierte Subquellen-/Prospekt-Diagnosen des Scrapes (Task P5). Optional
   *  für Abwärtskompatibilität; beim Resume defensiv sanitisiert wiederhergestellt,
   *  damit der Teilverlust-Schutz nicht still verloren geht. */
  subSourceDiagnostics?: SubSourceDiagnostic[];
}

/** Phase-2 progress saved so resume continues the model loop from
 *  `processedIndex` and never re-sends already-analysed representatives. */
export interface ScanV2CheckpointPhase2 {
  /** Unique product representatives to send to the model, in stable order. */
  representatives: Offer[];
  /** Followers that reuse a representative's analysis (same product key). */
  followers: Offer[];
  /** Food needing no model work (up-to-date + locked + Phase-A reuse), incl. the
   *  preserved REWE/nahkauf manual imports — carried so resume keeps them. */
  baseFood: Offer[];
  /** Sure non-food skipped in Phase 2 (goes straight to the filtered bucket). */
  skippedNonFood: Offer[];
  /** Phase-1 image verdicts to restore after the Python pass strips them. */
  imageById: Record<string, { imageStatus?: unknown; brokenImage?: unknown }>;
  /** How many representatives have been analysed + committed below. */
  processedIndex: number;
  /** Analysed food accumulated from completed batches. */
  analyzedFood: Offer[];
  /** Analysed (newly detected) non-food accumulated from completed batches. */
  analyzedFiltered: Offer[];
  candidatesCount: number;
  reusedFromBase: number;
  skippedLockedCount: number;
  aiClassifiedCount: number;
  fallbackCount: number;
  model: string;
  /** Aus Phase 1 übernommene Subquellen-/Prospekt-Diagnosen (Task P5), damit der
   *  Phase-2-Commit-Gate dieselbe strukturierte Basis hat und Resume sie nicht
   *  still verliert. Optional für Abwärtskompatibilität. */
  subSourceDiagnostics?: SubSourceDiagnostic[];
}

export interface ScanV2Checkpoint {
  version: number;
  mode: ScanV2Mode;
  /** The phase the run was paused in (drives whether resume restarts Phase 1). */
  phase: ScanV2Phase;
  startedAt: string;
  pausedAt: string;
  total: number;
  processed: number;
  /** Active store scope of the run. Persisted so resume uses EXACTLY the same
   *  scope (never widens to all shops). Optional on disk for backward compat —
   *  a pre-scope checkpoint is migrated via {@link resolveCheckpointScope}. */
  scope?: ScanV2Scope;
  phase1: ScanV2CheckpointPhase1 | null;
  phase2: ScanV2CheckpointPhase2 | null;
  diagnostics: Record<string, unknown>;
}

/** Lightweight summary (no offer arrays) for the status endpoint + startup. */
export interface ScanV2CheckpointMeta {
  version: number;
  mode: ScanV2Mode;
  phase: ScanV2Phase;
  startedAt: string;
  pausedAt: string;
  total: number;
  processed: number;
}

/** Resolve the checkpoint file path (env-overridable for tests/ops). */
export function resolveCheckpointFile(): string {
  const custom = process.env.SCAN_V2_CHECKPOINT_FILE?.trim();
  if (custom) return path.resolve(process.cwd(), custom);
  return path.resolve(process.cwd(), 'backend/data/scan-v2-checkpoint.json');
}

/**
 * Atomically persist the checkpoint: write a uniquely-named temp file in the
 * target directory, then rename it over the destination. Rename is atomic on the
 * same filesystem, so a reader never observes a half-written file. The temp file
 * is best-effort cleaned up if the rename fails.
 */
export async function writeCheckpointAtomic(
  filePath: string,
  checkpoint: ScanV2Checkpoint,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${randomUUID()}`);
  const serialized = JSON.stringify(checkpoint, null, 2);
  try {
    await fs.writeFile(tmp, serialized, 'utf8');
    await fs.rename(tmp, filePath);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function assertValidCheckpoint(raw: unknown): asserts raw is ScanV2Checkpoint {
  if (!isRecord(raw)) {
    throw new CheckpointCorruptError('Checkpoint ist kein Objekt.');
  }
  if (raw.version !== SCAN_V2_CHECKPOINT_VERSION) {
    throw new CheckpointCorruptError(
      `Checkpoint-Version ${String(raw.version)} != erwartet ${SCAN_V2_CHECKPOINT_VERSION}.`,
    );
  }
  for (const field of ['mode', 'phase', 'startedAt', 'pausedAt'] as const) {
    if (typeof raw[field] !== 'string' || (raw[field] as string).length === 0) {
      throw new CheckpointCorruptError(`Checkpoint-Feld "${field}" fehlt/ungültig.`);
    }
  }
  for (const field of ['total', 'processed'] as const) {
    if (typeof raw[field] !== 'number' || !Number.isFinite(raw[field])) {
      throw new CheckpointCorruptError(`Checkpoint-Feld "${field}" fehlt/ungültig.`);
    }
  }
  if (!('phase1' in raw) || !('phase2' in raw)) {
    throw new CheckpointCorruptError('Checkpoint ohne phase1/phase2-Abschnitt.');
  }
}

/**
 * Read + validate the checkpoint. Returns null when the file does not exist
 * (a clean "nothing to resume"), and throws {@link CheckpointCorruptError} when
 * the file exists but is unparseable / wrong-version / missing fields — never a
 * partially-populated object.
 */
export async function readCheckpoint(filePath: string): Promise<ScanV2Checkpoint | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CheckpointCorruptError('Checkpoint-Datei enthält kein gültiges JSON.');
  }
  assertValidCheckpoint(parsed);
  return parsed;
}

/** Delete the checkpoint file. No-op when it is already gone (force). */
export async function clearCheckpoint(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true }).catch(() => undefined);
}

/**
 * Items still to process on resume: everything after `processedIndex`. The index
 * is clamped to `[0, items.length]` so a corrupt/out-of-range value degrades to
 * "process all" / "process none" instead of throwing.
 */
export function pendingItems<T>(items: readonly T[], processedIndex: number): T[] {
  const start = Math.max(0, Math.min(items.length, Math.floor(processedIndex || 0)));
  return items.slice(start);
}

/**
 * Resolve the store scope to resume a checkpoint with. A checkpoint written by
 * the scope-aware code carries its scope verbatim → use it unchanged (never
 * widen on resume). A pre-scope checkpoint is migrated DEFENSIVELY:
 *
 *   • a Phase-1-inclusive run was always a full web scan → `all_stores`;
 *   • a Phase-2-only run derives its scope from the offers it actually carries
 *     (baseFood / representatives / followers / analysed / skipped non-food);
 *   • if nothing usable can be derived, the scope is genuinely UNCLEAR — we
 *     refuse rather than silently picking the risky "all shops" interpretation.
 *
 * Returns the scope, or `{ error }` for the unclear case so the caller can abort
 * the resume with an honest message instead of guessing.
 */
export function resolveCheckpointScope(
  checkpoint: ScanV2Checkpoint,
): ScanV2Scope | { error: string } {
  if (checkpoint.scope) return normalizeScope(checkpoint.scope);

  // Pre-scope migration: a full-scrape run is unambiguously all_stores.
  if (modeIncludesPhase1(checkpoint.mode)) return allStoresScope();

  // Phase-2-only legacy checkpoint: derive from the offers it carries.
  const phase2 = checkpoint.phase2;
  if (phase2) {
    const carried = [
      ...phase2.baseFood,
      ...phase2.representatives,
      ...phase2.followers,
      ...phase2.analyzedFood,
      ...phase2.analyzedFiltered,
      ...phase2.skippedNonFood,
    ];
    const derived = deriveScopeFromOffers(carried);
    if (derived.stores.length > 0) return derived;
  }

  return {
    error:
      'Alter Checkpoint ohne Scope-Information und ohne ableitbare Shops — Resume abgebrochen ' +
      '(kein riskantes Widen auf alle Shops). /clear-checkpoint und neu starten.',
  };
}

/** Pause keeps its checkpoint; a clean finish / explicit cancel discards it. An
 *  error keeps it so the operator can still resume after fixing the cause. */
export function checkpointDisposition(
  outcome: 'paused' | 'resuming' | 'cancelled' | 'done' | 'error',
): 'keep' | 'clear' {
  return outcome === 'cancelled' || outcome === 'done' ? 'clear' : 'keep';
}

/** Human status line, e.g. "Angebots-Scan 2.0 pausiert bei 1768/2164". */
export function summarizePausedMessage(input: { processed: number; total: number }): string {
  return `Angebots-Scan 2.0 pausiert bei ${input.processed}/${input.total}`;
}

/** Drop the heavy offer arrays, keeping only the meta the UI/status needs. */
export function summarizeCheckpoint(checkpoint: ScanV2Checkpoint): ScanV2CheckpointMeta {
  return {
    version: checkpoint.version,
    mode: checkpoint.mode,
    phase: checkpoint.phase,
    startedAt: checkpoint.startedAt,
    pausedAt: checkpoint.pausedAt,
    total: checkpoint.total,
    processed: checkpoint.processed,
  };
}
